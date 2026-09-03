import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Stripe from 'stripe';
import { resolveSiteConfig } from '../../config/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { seedPillars } from '../../db/seed.ts';
import { processedEvents } from '../../server/event-ledger/schema.ts';
import { subscribers } from '../crm/schema.ts';
import { emailLog } from '../email/schema.ts';
import { createEmailSender, type EmailSender } from '../email/service.ts';
import { invoices } from '../invoice/schema.ts';
import { nurtureEnrollments, nurtureSequences } from '../nurture/schema.ts';
import { SETTINGS_REGISTRY, settingsDefaults } from '../settings/registry.ts';
import { siteSettings } from '../settings/schema.ts';
import { buildCartMetadata, createCheckoutFromCart } from './checkout.ts';
import { createMockStripeGateway } from './mock-gateway.ts';
import { orderEvents, orders, products } from './schema.ts';
import { updateProduct } from './service.ts';
import {
	listEmptyCartEvents,
	processStripeEvent,
	verifyStripeEvent,
	type WebhookDeps
} from './webhook.ts';

// Delayed payment methods (audit 2026-09-03 P1 "pending orders are a dead
// end"): a Checkout session can complete with `payment_status: 'unpaid'`
// when the customer chose a bank debit / voucher method; Stripe then sends
// `checkout.session.async_payment_succeeded` or `…_failed`. A pending order
// must never be confirmed to the customer, and both results must be handled
// exactly-once in EITHER arrival order. Plus the card-only default that keeps
// this path closed unless the operator opens it.

const WEBHOOK_SECRET = 'whsec_async_spec_secret';
const stripeSigner = new Stripe('sk_test_offline_signing_only');
const SLEEP_PILLARS = resolveSiteConfig('sleep').pillars;

let db: Db;
let email: EmailSender;
let webhookDeps: WebhookDeps;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle')
	});
	await seedPillars(db, SLEEP_PILLARS);
	await db.insert(siteSettings).values(
		Object.entries({
			'company.legalName': 'Exemplu SRL',
			'company.cui': 'RO12345678',
			'company.vatRegistered': true,
			'company.regCom': 'J40/1234/2024',
			'company.address': 'Str. Exemplu 1, București',
			'invoice.seriesPrefix': 'ASY',
			'invoice.vatRateBp': 2100
		}).map(([key, value]) => ({ key, value }))
	);
	// An active order-paid nurture sequence: what a PAID order enrolls into.
	await db.insert(nurtureSequences).values({
		id: 'asy-seq-order-paid',
		key: 'asy-seq-order-paid',
		name: 'După comandă',
		trigger: { kind: 'order-paid' },
		consentKey: 'newsletter',
		steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'Pas 1', paragraphs: ['Unu.'] }],
		active: true
	});
	email = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
	webhookDeps = { db, email, siteName: 'Better Sleep' };
});

afterAll(async () => {
	await db?.$client.end();
});

let seq = 0;

async function makeProduct(stock: number | null = 10) {
	seq += 1;
	const [row] = await db
		.insert(products)
		.values({
			id: `asy-prod-${seq}`,
			slug: `asy-prod-${seq}`,
			name: `Produs asincron ${seq}`,
			priceCents: 4990,
			status: 'active',
			stock
		})
		.returning();
	return row;
}

async function mailableSubscriber(address: string) {
	seq += 1;
	const [row] = await db
		.insert(subscribers)
		.values({
			id: `asy-sub-${seq}`,
			email: address,
			consents: { newsletter: { granted: true, at: new Date().toISOString(), source: 'test' } },
			confirmedAt: new Date(),
			unsubscribeToken: `asy-unsub-${seq}`
		})
		.returning();
	return row;
}

type SessionEventType =
	| 'checkout.session.completed'
	| 'checkout.session.async_payment_succeeded'
	| 'checkout.session.async_payment_failed';

/** The three session events carry the SAME session object; only type and payment_status differ. */
function sessionEvent(input: {
	type: SessionEventType;
	id: string;
	paymentIntent: string;
	cart: Array<{ productId: string; qty: number; priceCents: number }>;
	amountTotal: number;
	email: string;
	eventId: string;
	paymentStatus?: 'paid' | 'unpaid';
	omitCart?: boolean;
}): string {
	return JSON.stringify({
		id: input.eventId,
		object: 'event',
		type: input.type,
		data: {
			object: {
				id: input.id,
				object: 'checkout.session',
				amount_total: input.amountTotal,
				currency: 'ron',
				payment_intent: input.paymentIntent,
				payment_status:
					input.paymentStatus ??
					(input.type === 'checkout.session.async_payment_succeeded' ? 'paid' : 'unpaid'),
				customer_details: { email: input.email, name: 'Ana Pop' },
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: { line1: 'Str. Somnului 10', city: 'Cluj-Napoca', country: 'RO' }
					}
				},
				metadata: input.omitCart ? {} : { cart: buildCartMetadata(input.cart) }
			}
		}
	});
}

async function deliver(payload: string) {
	const event = await verifyStripeEvent(
		payload,
		stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
		WEBHOOK_SECRET
	);
	return processStripeEvent(webhookDeps, event);
}

async function orderBySession(sessionId: string) {
	const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
	return order;
}

async function invoicesFor(orderId: string) {
	return db.select().from(invoices).where(eq(invoices.orderId, orderId));
}

async function eventKinds(orderId: string): Promise<string[]> {
	const trail = await db
		.select()
		.from(orderEvents)
		.where(eq(orderEvents.orderId, orderId))
		.orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
	return trail.map((e) => e.kind);
}

async function emailsTo(address: string) {
	return db.select().from(emailLog).where(eq(emailLog.toEmail, address));
}

async function stockOf(productId: string): Promise<number | null> {
	const [row] = await db.select().from(products).where(eq(products.id, productId));
	return row.stock;
}

/** One session's worth of fixtures: product, buyer, and the three events. */
async function scenario(tag: string, qty = 2) {
	const product = await makeProduct(10);
	const buyer = `${tag}@example.ro`;
	const subscriber = await mailableSubscriber(buyer);
	const base = {
		id: `cs_${tag}`,
		paymentIntent: `pi_${tag}`,
		cart: [{ productId: product.id, qty, priceCents: 4990 }],
		amountTotal: qty * 4990,
		email: buyer
	};
	return {
		product,
		buyer,
		subscriber,
		completed: sessionEvent({
			...base,
			type: 'checkout.session.completed',
			eventId: `evt_${tag}_c`
		}),
		succeeded: sessionEvent({
			...base,
			type: 'checkout.session.async_payment_succeeded',
			eventId: `evt_${tag}_s`
		}),
		failed: sessionEvent({
			...base,
			type: 'checkout.session.async_payment_failed',
			eventId: `evt_${tag}_f`
		})
	};
}

async function enrollmentsOf(subscriberId: string) {
	return db
		.select()
		.from(nurtureEnrollments)
		.where(eq(nurtureEnrollments.subscriberId, subscriberId));
}

describe('delayed payment methods (async_payment_succeeded / async_payment_failed)', () => {
	it('a completed-but-unpaid session creates a PENDING order: stock reserved, no invoice, NO confirmation email, no nurture', async () => {
		const s = await scenario('pending');
		const outcome = await deliver(s.completed);
		expect(outcome).toMatchObject({ kind: 'order-created', status: 'pending' });

		const order = await orderBySession('cs_pending');
		expect(order.status).toBe('pending');
		// The goods are held for the customer while the bank settles…
		expect(await stockOf(s.product.id)).toBe(8);
		// …but nothing is promised: no invoice (not paid), no "order confirmed"
		// email, no marketing trigger.
		expect(await invoicesFor(order.id)).toEqual([]);
		expect(await emailsTo(s.buyer)).toEqual([]);
		expect(await enrollmentsOf(s.subscriber.id)).toEqual([]);
		// A redelivery of the completed event does not change its mind.
		expect((await deliver(s.completed)).kind).toBe('duplicate-event');
		expect(await emailsTo(s.buyer)).toEqual([]);
	});

	it('async_payment_succeeded flips pending → paid exactly once: one invoice, one email, one enrollment; redelivery is a ledger hit', async () => {
		const s = await scenario('settles');
		await deliver(s.completed);

		const outcome = await deliver(s.succeeded);
		expect(outcome).toMatchObject({ kind: 'payment-succeeded' });
		const order = await orderBySession('cs_settles');
		expect(order.status).toBe('paid');
		expect(await stockOf(s.product.id)).toBe(8);
		expect((await invoicesFor(order.id)).map((d) => d.kind)).toEqual(['invoice']);
		expect(await emailsTo(s.buyer)).toHaveLength(1);
		expect(await enrollmentsOf(s.subscriber.id)).toHaveLength(1);
		// Same transaction → same `now()`; compare as a set, not by insertion order.
		expect((await eventKinds(order.id)).sort()).toEqual(
			['created', 'payment-succeeded', 'invoice-issued'].sort()
		);

		// Same event again, and a stray second completed: nothing doubles.
		expect((await deliver(s.succeeded)).kind).toBe('duplicate-event');
		expect((await deliver(s.completed)).kind).toBe('duplicate-event');
		expect(await invoicesFor(order.id)).toHaveLength(1);
		expect(await emailsTo(s.buyer)).toHaveLength(1);
		expect(await enrollmentsOf(s.subscriber.id)).toHaveLength(1);
		expect(await stockOf(s.product.id)).toBe(8);
	});

	it('async_payment_failed marks a pending order failed, restores the reserved stock and cancels fulfillment', async () => {
		const s = await scenario('fails');
		await deliver(s.completed);
		expect(await stockOf(s.product.id)).toBe(8);

		const outcome = await deliver(s.failed);
		expect(outcome).toMatchObject({ kind: 'payment-failed' });
		const order = await orderBySession('cs_fails');
		expect(order.status).toBe('failed');
		expect(order.fulfillmentStatus).toBe('cancelled');
		expect(await stockOf(s.product.id)).toBe(10);
		expect(await invoicesFor(order.id)).toEqual([]);
		expect(await emailsTo(s.buyer)).toEqual([]);
		expect(await eventKinds(order.id)).toContain('payment-failed');

		// Exactly once: a redelivery restores nothing twice.
		expect((await deliver(s.failed)).kind).toBe('duplicate-event');
		expect(await stockOf(s.product.id)).toBe(10);
		// A success for a failed order is acknowledged without resurrecting it.
		expect((await deliver(s.succeeded)).kind).toBe('payment-already-settled');
		expect((await orderBySession('cs_fails')).status).toBe('failed');
		expect(await stockOf(s.product.id)).toBe(10);
	});

	it('async_payment_succeeded arriving BEFORE completed creates the order paid; the later completed is a duplicate session', async () => {
		const s = await scenario('success-first');
		const outcome = await deliver(s.succeeded);
		expect(outcome).toMatchObject({ kind: 'order-created', status: 'paid' });
		const order = await orderBySession('cs_success-first');
		expect(order.status).toBe('paid');
		expect(await stockOf(s.product.id)).toBe(8);
		expect((await invoicesFor(order.id)).map((d) => d.kind)).toEqual(['invoice']);
		expect(await emailsTo(s.buyer)).toHaveLength(1);

		// The completed event (payment_status unpaid) must not downgrade it.
		expect((await deliver(s.completed)).kind).toBe('duplicate-session');
		expect((await orderBySession('cs_success-first')).status).toBe('paid');
		expect(await stockOf(s.product.id)).toBe(8);
		expect(await emailsTo(s.buyer)).toHaveLength(1);
	});

	it('async_payment_failed arriving BEFORE completed creates the order failed with no stock taken; the later completed creates nothing', async () => {
		const s = await scenario('failure-first');
		const outcome = await deliver(s.failed);
		expect(outcome).toMatchObject({ kind: 'payment-failed' });
		const order = await orderBySession('cs_failure-first');
		expect(order.status).toBe('failed');
		expect(order.fulfillmentStatus).toBe('cancelled');
		expect(await stockOf(s.product.id)).toBe(10);

		expect((await deliver(s.completed)).kind).toBe('duplicate-session');
		expect((await orderBySession('cs_failure-first')).status).toBe('failed');
		expect(await stockOf(s.product.id)).toBe(10);
		expect(await emailsTo(s.buyer)).toEqual([]);
	});

	it('racing: completed and async_payment_succeeded delivered concurrently converge on one paid order', async () => {
		const s = await scenario('race-settle');
		const outcomes = await Promise.all([deliver(s.completed), deliver(s.succeeded)]);
		expect(outcomes.map((o) => o.kind).sort()).toEqual(expect.arrayContaining(['order-created']));
		const rows = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_race-settle'));
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('paid');
		expect(await stockOf(s.product.id)).toBe(8);
		expect((await invoicesFor(rows[0].id)).map((d) => d.kind)).toEqual(['invoice']);
		expect(await emailsTo(s.buyer)).toHaveLength(1);
	});
});

describe('card-only by default', () => {
	it('the registry declares shop.allowAllPaymentMethods as a boolean that is OFF unless the operator turns it on', () => {
		expect(SETTINGS_REGISTRY['shop.allowAllPaymentMethods']).toMatchObject({
			kind: 'boolean',
			default: false,
			clientSafe: false
		});
		expect(settingsDefaults()['shop.allowAllPaymentMethods']).toBe(false);
	});

	it('checkout pins payment_method_types to card unless the setting opens the door', async () => {
		const product = await makeProduct(null);
		// Checkout only sells products tagged to a site pillar.
		await updateProduct({ db }, product.id, { pillarSlugs: ['somn'] });
		const gateway = createMockStripeGateway();
		const deps = { db, gateway, baseUrl: 'https://example.ro' };
		const items = [{ productId: product.id, qty: 1 }];

		const cardOnly = await createCheckoutFromCart(deps, {
			items,
			sitePillarSlugs: SLEEP_PILLARS,
			shippingSettings: settingsDefaults(),
			shippingOptionId: 'standard',
			paymentSettings: settingsDefaults()
		});
		if (!cardOnly.ok) throw new Error(cardOnly.error);
		expect(gateway.sessions.get(cardOnly.sessionId)!.input.paymentMethodTypes).toEqual(['card']);

		// Omitting the settings altogether is the same safe default.
		const implicit = await createCheckoutFromCart(deps, {
			items,
			sitePillarSlugs: SLEEP_PILLARS,
			shippingSettings: settingsDefaults(),
			shippingOptionId: 'standard'
		});
		if (!implicit.ok) throw new Error(implicit.error);
		expect(gateway.sessions.get(implicit.sessionId)!.input.paymentMethodTypes).toEqual(['card']);

		const opened = await createCheckoutFromCart(deps, {
			items,
			sitePillarSlugs: SLEEP_PILLARS,
			shippingSettings: settingsDefaults(),
			shippingOptionId: 'standard',
			paymentSettings: { 'shop.allowAllPaymentMethods': true }
		});
		if (!opened.ok) throw new Error(opened.error);
		// No list → Stripe applies whatever the dashboard enables.
		expect(gateway.sessions.get(opened.sessionId)!.input.paymentMethodTypes).toBeUndefined();
	});
});

describe('a completed session without a cart snapshot (audit P2)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('is logged at error level with the session id and amount, acknowledged as empty-cart, and listed for the admin', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const payload = sessionEvent({
			type: 'checkout.session.completed',
			id: 'cs_no_cart',
			paymentIntent: 'pi_no_cart',
			cart: [],
			amountTotal: 12345,
			email: 'no-cart@example.ro',
			eventId: 'evt_no_cart',
			paymentStatus: 'paid',
			omitCart: true
		});
		expect(await deliver(payload)).toEqual({ kind: 'empty-cart', sessionId: 'cs_no_cart' });

		expect(errorSpy).toHaveBeenCalledTimes(1);
		const line = String(errorSpy.mock.calls[0][0]);
		expect(line).toContain('cs_no_cart');
		expect(line).toContain('12345');
		expect(line).toContain('pi_no_cart');

		// No order, no email; the ledger row keeps the event for the admin.
		expect(await orderBySession('cs_no_cart')).toBeUndefined();
		expect(await emailsTo('no-cart@example.ro')).toEqual([]);
		const [ledger] = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, 'evt_no_cart'));
		expect(ledger.outcome).toBe('empty-cart');
		expect((await listEmptyCartEvents({ db })).map((e) => e.eventId)).toContain('evt_no_cart');

		// A redelivery is a ledger hit — logged once, not on every retry.
		expect((await deliver(payload)).kind).toBe('duplicate-event');
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});
});
