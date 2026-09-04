import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { ensureInvoicesForOrder, issuePartialStornoForOrder } from '../invoice/service.ts';
import { nurtureEnrollments, nurtureSequences } from '../nurture/schema.ts';
import { siteSettings } from '../settings/schema.ts';
import { buildCartMetadata } from './checkout.ts';
import { createMockCourierProvider, type MockCourierProvider } from './mock-courier.ts';
import { orderEvents, orders, products, shipments } from './schema.ts';
import { createShipmentForOrder } from './shipment-service.ts';
import { processStripeEvent, verifyStripeEvent, type WebhookDeps } from './webhook.ts';

// Money after the first payment (audit 2026-09-03 P0 #2 and #3), against the
// compose Postgres. Stripe never leaves the process: payloads are signed with
// the SDK's offline helper, the courier is the in-memory mock, email is dry.
//
// P0 #2: `charge.refunded` fires for PARTIAL refunds too, with
// `amount_refunded < amount`. Such a refund must leave the order paid, issue
// no storno and not touch fulfillment or the AWB — only record the amount.
// P0 #3: a refund whose order does not exist yet (event reordering, retry
// backlog) must be remembered, so the order is later created already
// refunded — never paid, invoiced, emailed and shipped for money returned.

const WEBHOOK_SECRET = 'whsec_refunds_spec_secret';
const stripeSigner = new Stripe('sk_test_offline_signing_only');

let db: Db;
let email: EmailSender;
let courier: MockCourierProvider;
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
	await seedPillars(db, resolveSiteConfig('sleep').pillars);
	// Complete issuer settings, so the webhook really issues the invoice and
	// the storno — the fiscal side of both findings is part of the failure.
	await db.insert(siteSettings).values(
		Object.entries({
			'company.legalName': 'Exemplu SRL',
			'company.cui': 'RO12345678',
			'company.vatRegistered': true,
			'company.regCom': 'J40/1234/2024',
			'company.address': 'Str. Exemplu 1, București',
			'invoice.seriesPrefix': 'RFD',
			'invoice.vatRateBp': 2100
		}).map(([key, value]) => ({ key, value }))
	);
	email = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
	courier = createMockCourierProvider();
	webhookDeps = { db, email, siteName: 'Better Sleep', courier };
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
			id: `rfd-prod-${seq}`,
			slug: `rfd-prod-${seq}`,
			name: `Produs rambursare ${seq}`,
			priceCents: 4990,
			status: 'active',
			stock
		})
		.returning();
	return row;
}

function sessionEvent(input: {
	id: string;
	paymentIntent: string;
	cart: Array<{ productId: string; qty: number; priceCents: number }>;
	amountTotal: number;
	email?: string;
	eventId?: string;
}): string {
	return JSON.stringify({
		id: input.eventId ?? `evt_${input.id}`,
		object: 'event',
		type: 'checkout.session.completed',
		data: {
			object: {
				id: input.id,
				object: 'checkout.session',
				amount_total: input.amountTotal,
				currency: 'ron',
				payment_intent: input.paymentIntent,
				payment_status: 'paid',
				// Phone + county: what the courier needs before an AWB (FIX-11).
				customer_details: {
					email: input.email ?? `client-${input.id}@example.ro`,
					name: 'Ana Pop',
					phone: '+40723000111'
				},
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: {
							line1: 'Str. Somnului 10',
							city: 'Cluj-Napoca',
							state: 'Cluj',
							country: 'RO'
						}
					}
				},
				metadata: { cart: buildCartMetadata(input.cart) }
			}
		}
	});
}

/** A real `charge.refunded` carries the charge amount AND the cumulative refunded amount. */
function refundEvent(input: {
	eventId: string;
	chargeId: string;
	paymentIntent: string;
	amount: number;
	amountRefunded: number;
}): string {
	return JSON.stringify({
		id: input.eventId,
		object: 'event',
		type: 'charge.refunded',
		data: {
			object: {
				id: input.chargeId,
				object: 'charge',
				payment_intent: input.paymentIntent,
				amount: input.amount,
				amount_refunded: input.amountRefunded,
				refunded: input.amountRefunded >= input.amount
			}
		}
	});
}

async function deliver(payload: string, deps: WebhookDeps = webhookDeps) {
	const event = await verifyStripeEvent(
		payload,
		stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
		WEBHOOK_SECRET
	);
	return processStripeEvent(deps, event);
}

async function orderBySession(sessionId: string) {
	const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
	return order;
}

async function invoicesFor(orderId: string) {
	return db
		.select()
		.from(invoices)
		.where(eq(invoices.orderId, orderId))
		.orderBy(asc(invoices.number));
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

describe('charge.refunded with amount_refunded < amount (audit P0 #2)', () => {
	it('a partial refund keeps the order paid, issues no storno, leaves fulfillment and the AWB alone, and records the amount', async () => {
		const product = await makeProduct(10);
		expect(
			(
				await deliver(
					sessionEvent({
						id: 'cs_partial',
						paymentIntent: 'pi_partial',
						cart: [{ productId: product.id, qty: 2, priceCents: 4990 }],
						amountTotal: 9980
					})
				)
			).kind
		).toBe('order-created');
		const order = await orderBySession('cs_partial');
		expect(order.status).toBe('paid');
		expect(await invoicesFor(order.id)).toHaveLength(1);

		// The parcel is already registered with the courier when the operator
		// refunds one of the two units (the oversell remedy the code recommends).
		const shipped = await createShipmentForOrder(
			{ db, courier, email, siteName: 'Better Sleep' },
			order.id,
			'admin@example.ro'
		);
		if (!shipped.ok) throw new Error(`shipment failed: ${shipped.error}`);
		const awb = shipped.value.shipment.awb;

		const outcome = await deliver(
			refundEvent({
				eventId: 'evt_partial_refund',
				chargeId: 'ch_partial',
				paymentIntent: 'pi_partial',
				amount: 9980,
				amountRefunded: 4990
			})
		);
		expect(outcome.kind).toBe('refund-partial');

		const after = await orderBySession('cs_partial');
		// Still a paid order, with the refunded amount on the row…
		expect(after.status).toBe('paid');
		expect(after.refundedCents).toBe(4990);
		// …no storno was issued (a fiscally false reversal of the whole invoice)…
		expect((await invoicesFor(order.id)).map((d) => d.kind)).toEqual(['invoice']);
		// …fulfillment and the AWB are untouched: the customer keeps one unit…
		expect(after.fulfillmentStatus).toBe('shipped');
		const [shipment] = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
		expect(shipment.status).toBe('registered');
		expect(courier.cancelled).not.toContain(awb);
		// …and the trail carries the partial refund with its amount.
		const kinds = await eventKinds(order.id);
		expect(kinds).toContain('refund-partial');
		expect(kinds).not.toContain('refund-marked');
		expect(kinds).not.toContain('storno-issued');
		const [entry] = (
			await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id))
		).filter((e) => e.kind === 'refund-partial');
		expect(entry.actor).toBe('stripe-webhook');
		expect(entry.note).toContain('4990');
	});

	it('a second partial refund raises the cumulative amount; a redelivery is a ledger hit', async () => {
		const product = await makeProduct(10);
		await deliver(
			sessionEvent({
				id: 'cs_partial_twice',
				paymentIntent: 'pi_partial_twice',
				cart: [{ productId: product.id, qty: 3, priceCents: 4990 }],
				amountTotal: 14970
			})
		);
		const order = await orderBySession('cs_partial_twice');

		const first = refundEvent({
			eventId: 'evt_pt_1',
			chargeId: 'ch_pt',
			paymentIntent: 'pi_partial_twice',
			amount: 14970,
			amountRefunded: 4990
		});
		expect((await deliver(first)).kind).toBe('refund-partial');
		// Stripe's amount_refunded is CUMULATIVE: the second event says 9980.
		const second = refundEvent({
			eventId: 'evt_pt_2',
			chargeId: 'ch_pt',
			paymentIntent: 'pi_partial_twice',
			amount: 14970,
			amountRefunded: 9980
		});
		expect((await deliver(second)).kind).toBe('refund-partial');
		let after = await orderBySession('cs_partial_twice');
		expect(after.status).toBe('paid');
		expect(after.refundedCents).toBe(9980);

		// Redelivery of the first event (a stale, lower amount) changes nothing.
		expect((await deliver(first)).kind).toBe('duplicate-event');
		after = await orderBySession('cs_partial_twice');
		expect(after.refundedCents).toBe(9980);
		expect((await eventKinds(order.id)).filter((k) => k === 'refund-partial')).toHaveLength(2);
		expect((await invoicesFor(order.id)).map((d) => d.kind)).toEqual(['invoice']);
	});

	it('a full refund (amount_refunded == amount) still takes the reversal path', async () => {
		const product = await makeProduct(10);
		await deliver(
			sessionEvent({
				id: 'cs_full',
				paymentIntent: 'pi_full',
				cart: [{ productId: product.id, qty: 1, priceCents: 4990 }],
				amountTotal: 4990
			})
		);
		const outcome = await deliver(
			refundEvent({
				eventId: 'evt_full_refund',
				chargeId: 'ch_full',
				paymentIntent: 'pi_full',
				amount: 4990,
				amountRefunded: 4990
			})
		);
		expect(outcome.kind).toBe('refund-marked');
		const after = await orderBySession('cs_full');
		expect(after.status).toBe('refunded');
		expect(after.refundedCents).toBe(4990);
		expect(after.fulfillmentStatus).toBe('cancelled');
		const docs = await invoicesFor(after.id);
		expect(docs.map((d) => d.kind)).toEqual(['invoice', 'storno']);
		expect(docs[1].grossTotalCents).toBe(-docs[0].grossTotalCents);
	});
});

describe('charge.refunded delivered before checkout.session.completed (audit P0 #3)', () => {
	// ONE active order-paid sequence for the whole block: exactly what a paid
	// order would enroll a mailable subscriber into (once per sequence).
	beforeAll(async () => {
		await db.insert(nurtureSequences).values({
			id: 'rfd-seq-order-paid',
			key: 'rfd-seq-order-paid',
			name: 'După comandă',
			trigger: { kind: 'order-paid' },
			consentKey: 'newsletter',
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'Pas 1', paragraphs: ['Unu.'] }],
			active: true
		});
	});

	/** A mailable subscriber — exactly who the order-paid trigger would enroll. */
	async function mailableSubscriber(address: string) {
		seq += 1;
		const [row] = await db
			.insert(subscribers)
			.values({
				id: `rfd-sub-${seq}`,
				email: address,
				consents: { newsletter: { granted: true, at: new Date().toISOString(), source: 'test' } },
				confirmedAt: new Date(),
				unsubscribeToken: `rfd-unsub-${seq}`
			})
			.returning();
		return row;
	}

	async function enrollmentsOf(subscriberId: string) {
		return db
			.select()
			.from(nurtureEnrollments)
			.where(eq(nurtureEnrollments.subscriberId, subscriberId));
	}

	it('a full refund before the order: the order is created refunded — invoice + storno, no email, no nurture, no stock taken; both events exactly-once', async () => {
		const buyer = 'early-refund@example.ro';
		const subscriber = await mailableSubscriber(buyer);
		const product = await makeProduct(10);

		const refund = refundEvent({
			eventId: 'evt_early_refund',
			chargeId: 'ch_early',
			paymentIntent: 'pi_early',
			amount: 9980,
			amountRefunded: 9980
		});
		// No order matches yet: the refund must be REMEMBERED (and the event
		// still acknowledged exactly once), not dropped on the floor.
		expect((await deliver(refund)).kind).toBe('refund-pending');

		const session = sessionEvent({
			id: 'cs_early',
			paymentIntent: 'pi_early',
			cart: [{ productId: product.id, qty: 2, priceCents: 4990 }],
			amountTotal: 9980,
			email: buyer
		});
		expect((await deliver(session)).kind).toBe('order-created');

		const order = await orderBySession('cs_early');
		expect(order.status).toBe('refunded');
		expect(order.refundedCents).toBe(9980);
		// Never going to be fulfilled — must not sit in the work queue.
		expect(order.fulfillmentStatus).toBe('cancelled');
		// The fiscal record is complete: invoice AND its storno.
		const docs = await invoicesFor(order.id);
		expect(docs.map((d) => d.kind)).toEqual(['invoice', 'storno']);
		expect(docs[1].grossTotalCents).toBe(-docs[0].grossTotalCents);
		// No "order confirmed" email, no nurture enrollment for money returned.
		expect(await emailsTo(buyer)).toEqual([]);
		expect(await enrollmentsOf(subscriber.id)).toEqual([]);
		// The goods never left: stock is not consumed by a dead-on-arrival order.
		const [stock] = await db.select().from(products).where(eq(products.id, product.id));
		expect(stock.stock).toBe(10);
		const kinds = await eventKinds(order.id);
		expect(kinds).toContain('created');
		expect(kinds).toContain('refund-marked');

		// Exactly-once in this order too: redelivering either event does nothing.
		expect((await deliver(refund)).kind).toBe('duplicate-event');
		expect((await deliver(session)).kind).toBe('duplicate-event');
		expect(await invoicesFor(order.id)).toHaveLength(2);
		expect(await emailsTo(buyer)).toEqual([]);
		const ledger = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, 'evt_early_refund'));
		expect(ledger).toHaveLength(1);
	});

	it('a partial refund before the order: created paid with the amount and the trail entry; email and nurture proceed', async () => {
		const buyer = 'early-partial@example.ro';
		const subscriber = await mailableSubscriber(buyer);
		const product = await makeProduct(10);

		expect(
			(
				await deliver(
					refundEvent({
						eventId: 'evt_early_partial',
						chargeId: 'ch_early_partial',
						paymentIntent: 'pi_early_partial',
						amount: 9980,
						amountRefunded: 4990
					})
				)
			).kind
		).toBe('refund-pending');
		expect(
			(
				await deliver(
					sessionEvent({
						id: 'cs_early_partial',
						paymentIntent: 'pi_early_partial',
						cart: [{ productId: product.id, qty: 2, priceCents: 4990 }],
						amountTotal: 9980,
						email: buyer
					})
				)
			).kind
		).toBe('order-created');

		const order = await orderBySession('cs_early_partial');
		expect(order.status).toBe('paid');
		expect(order.refundedCents).toBe(4990);
		expect(order.fulfillmentStatus).toBe('unfulfilled');
		expect((await invoicesFor(order.id)).map((d) => d.kind)).toEqual(['invoice']);
		expect(await eventKinds(order.id)).toContain('refund-partial');
		// The customer keeps one unit: stock is consumed, the confirmation goes
		// out and the order-paid nurture trigger fires as for any paid order.
		const [stock] = await db.select().from(products).where(eq(products.id, product.id));
		expect(stock.stock).toBe(8);
		expect(await emailsTo(buyer)).toHaveLength(1);
		expect(await enrollmentsOf(subscriber.id)).toHaveLength(1);
	});

	it('the usual order (session first, refund second) is unchanged and exactly-once', async () => {
		const buyer = 'usual-order@example.ro';
		const product = await makeProduct(10);
		const session = sessionEvent({
			id: 'cs_usual',
			paymentIntent: 'pi_usual',
			cart: [{ productId: product.id, qty: 1, priceCents: 4990 }],
			amountTotal: 4990,
			email: buyer
		});
		const refund = refundEvent({
			eventId: 'evt_usual_refund',
			chargeId: 'ch_usual',
			paymentIntent: 'pi_usual',
			amount: 4990,
			amountRefunded: 4990
		});
		expect((await deliver(session)).kind).toBe('order-created');
		expect((await deliver(refund)).kind).toBe('refund-marked');
		const order = await orderBySession('cs_usual');
		expect(order.status).toBe('refunded');
		expect((await invoicesFor(order.id)).map((d) => d.kind)).toEqual(['invoice', 'storno']);
		// The confirmation went out while the order was still paid — one email.
		expect(await emailsTo(buyer)).toHaveLength(1);

		expect((await deliver(session)).kind).toBe('duplicate-event');
		expect((await deliver(refund)).kind).toBe('duplicate-event');
		expect(await invoicesFor(order.id)).toHaveLength(2);
		expect(await emailsTo(buyer)).toHaveLength(1);
	});

	it('racing deliveries of the refund and the session converge on one refunded order', async () => {
		const buyer = 'race-refund@example.ro';
		const product = await makeProduct(10);
		const session = sessionEvent({
			id: 'cs_race_refund',
			paymentIntent: 'pi_race_refund',
			cart: [{ productId: product.id, qty: 1, priceCents: 4990 }],
			amountTotal: 4990,
			email: buyer
		});
		const refund = refundEvent({
			eventId: 'evt_race_refund',
			chargeId: 'ch_race',
			paymentIntent: 'pi_race_refund',
			amount: 4990,
			amountRefunded: 4990
		});

		// Whichever wins the race, the end state is the same: the order exists
		// exactly once and is refunded, with its invoice and storno.
		const outcomes = await Promise.all([deliver(refund), deliver(session)]);
		expect(outcomes[1].kind).toBe('order-created');
		expect(['refund-marked', 'refund-pending']).toContain(outcomes[0].kind);

		const rows = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_race_refund'));
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('refunded');
		expect(rows[0].refundedCents).toBe(4990);
		expect((await invoicesFor(rows[0].id)).map((d) => d.kind)).toEqual(['invoice', 'storno']);
		// A refund that landed first means no confirmation was ever sent; a
		// session that landed first sent it while the order was paid. Either
		// way there is never more than one, and never a nurture enrollment
		// for a refunded order created from a pending refund.
		expect((await emailsTo(buyer)).length).toBeLessThanOrEqual(1);
	});
});

describe('storno arithmetic across partial and full refunds', () => {
	it('a full refund after a partial storno reverses only the remainder, so Σ stornos = the invoice', async () => {
		const product = await makeProduct(10);
		await deliver(
			sessionEvent({
				id: 'cs_partial_then_full',
				paymentIntent: 'pi_partial_then_full',
				cart: [{ productId: product.id, qty: 2, priceCents: 4990 }],
				amountTotal: 9980
			})
		);
		const order = await orderBySession('cs_partial_then_full');

		// One unit refunded, then the operator issues the partial storno for it.
		expect(
			(
				await deliver(
					refundEvent({
						eventId: 'evt_ptf_partial',
						chargeId: 'ch_ptf',
						paymentIntent: 'pi_partial_then_full',
						amount: 9980,
						amountRefunded: 4990
					})
				)
			).kind
		).toBe('refund-partial');
		const partial = await issuePartialStornoForOrder({ db }, order.id, 'admin@example.ro');
		expect(partial.ok && partial.value.invoice.grossTotalCents).toBe(-4990);

		// Then the rest is refunded: the automatic storno covers ONLY the rest.
		expect(
			(
				await deliver(
					refundEvent({
						eventId: 'evt_ptf_full',
						chargeId: 'ch_ptf',
						paymentIntent: 'pi_partial_then_full',
						amount: 9980,
						amountRefunded: 9980
					})
				)
			).kind
		).toBe('refund-marked');
		const after = await orderBySession('cs_partial_then_full');
		expect(after.status).toBe('refunded');
		expect(after.refundedCents).toBe(9980);
		const docs = await invoicesFor(order.id);
		expect(docs.map((d) => d.kind)).toEqual(['invoice', 'storno', 'storno']);
		expect(docs.map((d) => d.grossTotalCents)).toEqual([9980, -4990, -4990]);
		expect(docs[1].grossTotalCents + docs[2].grossTotalCents).toBe(-docs[0].grossTotalCents);

		// Fully reversed: the one-click retry issues nothing more.
		const ensured = await ensureInvoicesForOrder({ db }, order.id, 'admin@example.ro');
		expect(ensured.ok && ensured.value.storno?.id).toBe(docs[2].id);
		expect(await invoicesFor(order.id)).toHaveLength(3);
		expect((await eventKinds(order.id)).filter((k) => k === 'storno-issued')).toHaveLength(2);
	});

	it('the database itself refuses a storno beyond the original, whatever path inserts it', async () => {
		const product = await makeProduct(10);
		await deliver(
			sessionEvent({
				id: 'cs_storno_bound',
				paymentIntent: 'pi_storno_bound',
				cart: [{ productId: product.id, qty: 1, priceCents: 4990 }],
				amountTotal: 4990
			})
		);
		const order = await orderBySession('cs_storno_bound');
		await deliver(
			refundEvent({
				eventId: 'evt_storno_bound',
				chargeId: 'ch_bound',
				paymentIntent: 'pi_storno_bound',
				amount: 4990,
				amountRefunded: 4990
			})
		);
		const [original] = await invoicesFor(order.id);
		// A raw second storno of even one ban past the invoice is rejected —
		// drizzle wraps the pg error, so the trigger's message sits on `cause`.
		let caught: unknown;
		try {
			await db.execute(sql`
				insert into invoices (id, kind, series, number, display_number, order_id, storno_of_invoice_id,
					issued_at, due_at, currency, issuer_name, issuer_cui, issuer_vat_registered, issuer_reg_com,
					issuer_address, buyer_name, net_total_cents, vat_total_cents, gross_total_cents)
				select 'raw-storno-over', 'storno', series, 9999, 'RFD-9999', order_id, id,
					now(), now(), currency, issuer_name, issuer_cui, issuer_vat_registered, issuer_reg_com,
					issuer_address, buyer_name, -1, 0, -1
				from invoices where id = ${original.id}`);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error & { cause?: { message?: string } };
		expect(`${error.message} ${error.cause?.message ?? ''}`).toMatch(/exceeds the original/);
		expect(await invoicesFor(order.id)).toHaveLength(2);
	});
});
