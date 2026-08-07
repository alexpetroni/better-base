import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Stripe from 'stripe';
import { resolveSiteConfig } from '../../config/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { seedPillars } from '../../db/seed.ts';
import { emailLog } from '../email/schema.ts';
import { createEmailSender, type EmailSender } from '../email/service.ts';
import { invoiceLines, invoices } from '../invoice/schema.ts';
import { siteSettings } from '../settings/schema.ts';
import { buildCartMetadata } from './checkout.ts';
import { createMockCourierProvider, type MockCourierProvider } from './mock-courier.ts';
import { orderEvents, orders, products, shipments, type OrderRow } from './schema.ts';
import {
	createShipmentForOrder,
	syncShipmentStatuses,
	type CreateShipmentDeps
} from './shipment-service.ts';
import { buildShippingMetadata } from './shipping.ts';
import { processStripeEvent, verifyStripeEvent, type WebhookDeps } from './webhook.ts';

// Shipping end-to-end at the service level, against the compose Postgres:
// checkout metadata → webhook order (goods + shipping + grand total
// consistent, invoice gross == the Stripe amount), AWB generation
// (idempotent, state machine, events, one email per AWB), the cron status
// sync (bounded, idempotent) and the refund rule. The courier is ALWAYS the
// in-memory mock — no test can reach a courier API.

const WEBHOOK_SECRET = 'whsec_shipment_spec_secret';
const stripeSigner = new Stripe('sk_test_offline_signing_only');

const VAT_RATE_BP = 2100;

let db: Db;
let email: EmailSender;
let courier: MockCourierProvider;
let webhookDeps: WebhookDeps;
let shipDeps: CreateShipmentDeps;

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
	await seedPillars(db, resolveSiteConfig('sleep').pillars);

	// Issuer settings so the webhook ISSUES invoices here (unlike shop.spec,
	// which exercises the settings-less failure path on purpose): the phase's
	// regression anchor is invoice gross == Stripe amount, shipping included.
	await db.insert(siteSettings).values(
		Object.entries({
			'company.legalName': 'Exemplu SRL',
			'company.cui': 'RO12345678',
			'company.vatRegistered': true,
			'company.regCom': 'J40/1234/2024',
			'company.address': 'Str. Exemplu 1, București',
			'invoice.seriesPrefix': 'SHP',
			'invoice.vatRateBp': VAT_RATE_BP
		}).map(([key, value]) => ({ key, value }))
	);

	email = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
	courier = createMockCourierProvider();
	webhookDeps = { db, email, siteName: 'Better Sleep', courier };
	shipDeps = {
		db,
		courier,
		email,
		siteName: 'Better Sleep',
		publicBaseUrl: 'https://bettersleep.example'
	};
});

afterAll(async () => {
	await db?.$client.end();
});

let seq = 0;

/** A paid order created through the REAL webhook path, shipping included. */
async function orderViaWebhook(input: {
	goodsCents?: number;
	shippingCents?: number;
	shippingName?: string;
	/** Omit shipping_cost from the session to exercise the metadata fallback. */
	omitShippingCost?: boolean;
}): Promise<OrderRow> {
	seq += 1;
	const goods = input.goodsCents ?? 9980;
	const shipping = input.shippingCents ?? 1990;
	const [product] = await db
		.insert(products)
		.values({
			id: `ship-prod-${seq}`,
			slug: `ship-prod-${seq}`,
			name: `Produs livrare ${seq}`,
			priceCents: goods,
			status: 'active'
		})
		.returning();

	const payload = JSON.stringify({
		id: `evt_ship_${seq}`,
		object: 'event',
		type: 'checkout.session.completed',
		data: {
			object: {
				id: `cs_ship_${seq}`,
				object: 'checkout.session',
				amount_total: goods + shipping,
				...(input.omitShippingCost ? {} : { shipping_cost: { amount_total: shipping } }),
				currency: 'ron',
				payment_intent: `pi_ship_${seq}`,
				payment_status: 'paid',
				customer_details: { email: `client${seq}@example.ro`, name: 'Ana Pop' },
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: {
							line1: 'Str. Somnului 10',
							city: 'Cluj-Napoca',
							postal_code: '400001',
							country: 'RO'
						}
					}
				},
				metadata: {
					cart: buildCartMetadata([{ productId: product.id, qty: 1, priceCents: goods }]),
					ship: buildShippingMetadata({
						id: 'standard',
						name: input.shippingName ?? 'Curier standard',
						priceCents: shipping,
						etaText: '',
						freeOverThreshold: false
					})
				}
			}
		}
	});
	const signature = stripeSigner.webhooks.generateTestHeaderString({
		payload,
		secret: WEBHOOK_SECRET
	});
	const event = await verifyStripeEvent(payload, signature, WEBHOOK_SECRET);
	const outcome = await processStripeEvent(webhookDeps, event);
	if (outcome.kind !== 'order-created') throw new Error(`unexpected outcome ${outcome.kind}`);
	const [order] = await db.select().from(orders).where(eq(orders.id, outcome.orderId));
	return order;
}

async function refundViaWebhook(order: OrderRow): Promise<void> {
	const payload = JSON.stringify({
		id: `evt_refund_${order.stripePaymentIntent}`,
		object: 'event',
		type: 'charge.refunded',
		data: {
			object: {
				id: `ch_${order.stripePaymentIntent}`,
				object: 'charge',
				payment_intent: order.stripePaymentIntent
			}
		}
	});
	const signature = stripeSigner.webhooks.generateTestHeaderString({
		payload,
		secret: WEBHOOK_SECRET
	});
	const event = await verifyStripeEvent(payload, signature, WEBHOOK_SECRET);
	const outcome = await processStripeEvent(webhookDeps, event);
	if (outcome.kind !== 'refund-marked') throw new Error(`unexpected outcome ${outcome.kind}`);
}

async function eventKinds(orderId: string): Promise<string[]> {
	const trail = await db
		.select()
		.from(orderEvents)
		.where(eq(orderEvents.orderId, orderId))
		.orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
	return trail.map((e) => e.kind);
}

describe('webhook order amounts with shipping', () => {
	it('the order carries goods, shipping and grand total consistently', async () => {
		const order = await orderViaWebhook({ goodsCents: 9980, shippingCents: 1990 });
		expect(order.amountTotalCents).toBe(11970);
		expect(order.shippingCents).toBe(1990);
		expect(order.shippingName).toBe('Curier standard');
		// goods = grand total − shipping, by construction.
		expect(order.amountTotalCents - order.shippingCents).toBe(9980);
	});

	it('falls back to the metadata snapshot when the session has no shipping_cost', async () => {
		const order = await orderViaWebhook({ shippingCents: 2590, omitShippingCost: true });
		expect(order.shippingCents).toBe(2590);
	});

	it('REGRESSION ANCHOR: the invoice gross equals the Stripe amount, shipping as its own VAT line', async () => {
		const order = await orderViaWebhook({
			goodsCents: 9980,
			shippingCents: 1990,
			shippingName: 'Curier rapid'
		});
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		expect(invoice).toBeDefined();
		expect(invoice.kind).toBe('invoice');
		// THE equality: what the fiscal record claims is what Stripe charged.
		expect(invoice.grossTotalCents).toBe(order.amountTotalCents);

		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, invoice.id))
			.orderBy(asc(invoiceLines.position));
		expect(lines).toHaveLength(2);
		const shippingLine = lines[1];
		expect(shippingLine.description).toBe('Transport — Curier rapid');
		expect(shippingLine.qty).toBe(1);
		expect(shippingLine.grossCents).toBe(1990);
		expect(shippingLine.vatRateBp).toBe(VAT_RATE_BP);
		// VAT extracted from the gross shipping price: 1990·2100/12100 ≈ 345.
		expect(shippingLine.vatCents).toBe(345);
		expect(shippingLine.netCents).toBe(1990 - 345);
		// Totals are sums of the lines, so they include the shipping VAT.
		expect(invoice.vatTotalCents).toBe(lines[0].vatCents + shippingLine.vatCents);
	});

	it('a free-shipping order gets no transport line and still reconciles', async () => {
		const order = await orderViaWebhook({ goodsCents: 5000, shippingCents: 0 });
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		expect(invoice.grossTotalCents).toBe(order.amountTotalCents);
		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, invoice.id));
		expect(lines).toHaveLength(1);
	});
});

describe('AWB generation (admin action service)', () => {
	it('registers the shipment, walks unfulfilled → packed → shipped, and is idempotent', async () => {
		const order = await orderViaWebhook({});

		const first = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.created).toBe(true);
		const shipment = first.value.shipment;
		expect(shipment.provider).toBe('mock');
		expect(shipment.awb).toMatch(/^MOCKAWB/);
		expect(shipment.trackingUrl).toContain(shipment.awb);
		expect(shipment.status).toBe('registered');

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('shipped');
		// The trail: AWB + both machine transitions, atomically with the row.
		const kinds = await eventKinds(order.id);
		expect(kinds.filter((k) => k === 'awb-generated')).toHaveLength(1);
		expect(kinds.filter((k) => k === 'fulfillment-transition')).toHaveLength(2);

		// Pressing the button again: same shipment, no new AWB, no new events.
		const second = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(second.ok && !second.value.created).toBe(true);
		expect(second.ok && second.value.shipment.id).toBe(shipment.id);
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toHaveLength(
			1
		);
		expect((await eventKinds(order.id)).filter((k) => k === 'awb-generated')).toHaveLength(1);
		expect(courier.shipments.size).toBeGreaterThan(0);

		// Exactly ONE shipping email, keyed on the AWB, dry-run captured.
		const logs = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `shipping-notification:${shipment.awb}`));
		expect(logs).toHaveLength(1);
		expect(logs[0].status).toBe('dryrun');
		expect(logs[0].template).toBe('shipping-notification');
		expect(logs[0].toEmail).toBe(after.email);
		expect(logs[0].data).toMatchObject({
			awb: shipment.awb,
			trackingUrl: shipment.trackingUrl,
			orderUrl: `https://bettersleep.example/cos/succes?session_id=${after.stripeSessionId}`
		});
	});

	it('ships from packed too, with a single remaining transition', async () => {
		const order = await orderViaWebhook({});
		// Operator packed explicitly first.
		const { transitionFulfillment } = await import('./fulfillment-service.ts');
		await transitionFulfillment({ db }, order.id, 'packed', { actor: 'admin@example.ro' });

		const result = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(result.ok).toBe(true);
		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('shipped');
	});

	it('refuses unpaid and already-shipped orders', async () => {
		const [pending] = await db
			.insert(orders)
			.values({
				id: 'ship-pending',
				email: 'p@example.ro',
				stripeSessionId: 'cs_ship_pending',
				amountTotalCents: 1000,
				currency: 'ron',
				status: 'pending'
			})
			.returning();
		const unpaid = await createShipmentForOrder(shipDeps, pending.id, 'admin@example.ro');
		expect(!unpaid.ok && unpaid.error).toBe('order-not-paid');

		const missing = await createShipmentForOrder(shipDeps, 'no-such-order', 'admin@example.ro');
		expect(!missing.ok && missing.error).toBe('order-not-found');

		// Terminal fulfillment: nothing to ship.
		const order = await orderViaWebhook({});
		const { transitionFulfillment } = await import('./fulfillment-service.ts');
		await transitionFulfillment({ db }, order.id, 'cancelled', { actor: 'admin@example.ro' });
		const done = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(!done.ok && done.error).toBe('order-not-shippable');
	});

	it('a courier failure writes nothing: no shipment, no transition, no email', async () => {
		const order = await orderViaWebhook({});
		courier.failNextCreate = new Error('sameday down');

		const result = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(!result.ok && result.error).toBe('courier');
		expect(!result.ok && result.detail).toContain('sameday down');

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('unfulfilled');
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toHaveLength(
			0
		);
		expect((await eventKinds(order.id)).includes('awb-generated')).toBe(false);

		// The retry after the courier recovers succeeds normally.
		const retry = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(retry.ok && retry.value.created).toBe(true);
	});
});

describe('cron shipment-status sync', () => {
	it('is a no-op with nothing in flight', async () => {
		// Everything registered so far in THIS block's fresh sub-state: move all
		// existing in-flight rows out of the way by syncing against reality.
		await db.update(shipments).set({ status: 'delivered' });
		const result = await syncShipmentStatuses({ db, courier });
		expect(result).toEqual({ polled: 0, updated: 0, errors: 0 });
	});

	it('updates changed statuses, transitions fulfillment, and is idempotent', async () => {
		const order = await orderViaWebhook({});
		const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		if (!created.ok) throw new Error('shipment failed');
		const awb = created.value.shipment.awb;

		// No courier-side change yet: polled but nothing written.
		const idle = await syncShipmentStatuses({ db, courier });
		expect(idle.polled).toBe(1);
		expect(idle.updated).toBe(0);

		courier.setTrackingStatus(awb, 'in-transit');
		const moved = await syncShipmentStatuses({ db, courier });
		expect(moved.updated).toBe(1);
		let [shipment] = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
		expect(shipment.status).toBe('in-transit');
		// In transit is not a fulfillment change — still shipped.
		let [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('shipped');

		// Running twice with no change writes nothing new (idempotent).
		const again = await syncShipmentStatuses({ db, courier });
		expect(again.updated).toBe(0);
		expect((await eventKinds(order.id)).filter((k) => k === 'shipment-status')).toHaveLength(1);

		courier.setTrackingStatus(awb, 'delivered');
		await syncShipmentStatuses({ db, courier });
		[shipment] = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
		expect(shipment.status).toBe('delivered');
		[row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('delivered');
		// A delivered shipment leaves the polling set entirely.
		const done = await syncShipmentStatuses({ db, courier });
		expect(done.polled).toBe(0);
	});

	it('respects the per-run bound, oldest-synced first', async () => {
		const trio = [];
		for (let i = 0; i < 3; i += 1) {
			const order = await orderViaWebhook({});
			const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
			if (!created.ok) throw new Error('shipment failed');
			trio.push(created.value.shipment);
		}

		const bounded = await syncShipmentStatuses({ db, courier }, { limit: 2 });
		expect(bounded.polled).toBe(2);
		// The two polled rows got a lastSyncedAt; the third is still null and
		// goes FIRST on the next run — the batch rotates through the backlog.
		const rows = await db
			.select()
			.from(shipments)
			.where(eq(shipments.status, 'registered'))
			.orderBy(asc(shipments.createdAt));
		expect(rows.filter((r) => r.lastSyncedAt === null)).toHaveLength(1);

		const next = await syncShipmentStatuses({ db, courier }, { limit: 2 });
		expect(next.polled).toBe(2);
		const after = await db.select().from(shipments).where(eq(shipments.status, 'registered'));
		expect(after.every((r) => r.lastSyncedAt !== null)).toBe(true);
		// Park them so later tests start from a clean in-flight set.
		await db.update(shipments).set({ status: 'delivered' });
	});

	it('a courier lookup failure skips the row and keeps the run alive', async () => {
		const order = await orderViaWebhook({});
		const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		if (!created.ok) throw new Error('shipment failed');
		// Simulate a courier-side unknown: delete it from the mock's memory.
		courier.shipments.delete(created.value.shipment.awb);

		const result = await syncShipmentStatuses({ db, courier });
		expect(result.polled).toBe(1);
		expect(result.updated).toBe(0);
		await db.update(shipments).set({ status: 'delivered' });
	});
});

describe('refund vs fulfillment/shipment rule', () => {
	it('refund BEFORE any AWB cancels the order', async () => {
		const order = await orderViaWebhook({});
		await refundViaWebhook(order);

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.status).toBe('refunded');
		expect(after.fulfillmentStatus).toBe('cancelled');
		// The storno negates the WHOLE invoice, shipping line included.
		const docs = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		const storno = docs.find((d) => d.kind === 'storno');
		expect(storno?.grossTotalCents).toBe(-after.amountTotalCents);
	});

	it('refund after an AWB that is not picked up cancels it with the courier and marks the order returned', async () => {
		const order = await orderViaWebhook({});
		const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		if (!created.ok) throw new Error('shipment failed');
		const awb = created.value.shipment.awb;

		await refundViaWebhook(order);

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('returned');
		const [shipment] = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
		expect(shipment.status).toBe('cancelled');
		expect(courier.cancelled).toContain(awb);
		expect(await eventKinds(order.id)).toContain('shipment-cancelled');
	});

	it('refund after pickup marks order and shipment returned without a courier cancel', async () => {
		const order = await orderViaWebhook({});
		const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		if (!created.ok) throw new Error('shipment failed');
		const awb = created.value.shipment.awb;
		courier.setTrackingStatus(awb, 'in-transit');
		await syncShipmentStatuses({ db, courier });

		const cancelledBefore = courier.cancelled.length;
		await refundViaWebhook(order);

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('returned');
		const [shipment] = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
		expect(shipment.status).toBe('returned');
		expect(courier.cancelled).toHaveLength(cancelledBefore);
		// Returned rows leave the polling set.
		expect((await syncShipmentStatuses({ db, courier })).polled).toBe(0);
	});
});
