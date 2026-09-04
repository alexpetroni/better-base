import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
import { CourierAuthError, type CourierProvider } from './courier.ts';
import { SHIPMENT_SYNC_ACTOR } from './fulfillment.ts';
import { createMockCourierProvider, type MockCourierProvider } from './mock-courier.ts';
import {
	orderEvents,
	orders,
	products,
	shipments,
	type OrderRow,
	type ShipmentRow
} from './schema.ts';
import {
	createShipmentForOrder,
	getShipmentForOrder,
	SHIPMENT_SYNC_BACKOFF_BASE_MS,
	SHIPMENT_SYNC_BACKOFF_MAX_MS,
	shipmentSyncHealth,
	syncBackoffMs,
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
			'company.cui': 'RO12345676',
			'company.vatRegistered': true,
			'company.regCom': 'J40/1234/2024',
			'company.address': 'Str. Exemplu 1, București',
			'invoice.seriesPrefix': 'SHP',
			'invoice.vatStandardRates': '2025-08-01 21'
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

afterEach(() => {
	vi.restoreAllMocks();
});

let seq = 0;
const ACTOR = 'admin@example.ro';

/** Poll (from a pool connection, i.e. across transactions) until a row of this status is committed. */
async function waitForShipment(
	orderId: string,
	status: ShipmentRow['status']
): Promise<ShipmentRow> {
	for (let i = 0; i < 100; i += 1) {
		const [row] = await db
			.select()
			.from(shipments)
			.where(and(eq(shipments.orderId, orderId), eq(shipments.status, status)));
		if (row) return row;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`no ${status} shipment for ${orderId} within 2s`);
}

/** The mock courier with a createShipment that waits until the test releases it. */
function gatedCourier(): { courier: CourierProvider; release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	return {
		release,
		courier: {
			name: courier.name,
			getLabel: (awb) => courier.getLabel(awb),
			trackShipment: (awb) => courier.trackShipment(awb),
			cancelShipment: (awb) => courier.cancelShipment(awb),
			async createShipment(request) {
				await gate;
				return courier.createShipment(request);
			}
		}
	};
}

/**
 * Move every in-flight row out of the polling set. Only in-flight rows: a
 * replaced (cancelled/failed) row set to `delivered` would become a second
 * live row for its order and trip the partial unique index.
 */
async function parkInFlight(): Promise<void> {
	await db
		.update(shipments)
		.set({ status: 'delivered' })
		.where(inArray(shipments.status, ['registered', 'in-transit']));
}

async function shipmentRows(orderId: string): Promise<ShipmentRow[]> {
	return db
		.select()
		.from(shipments)
		.where(eq(shipments.orderId, orderId))
		.orderBy(asc(shipments.createdAt));
}

/** A paid order created through the REAL webhook path, shipping included. */
async function orderViaWebhook(input: {
	goodsCents?: number;
	shippingCents?: number;
	shippingName?: string;
	/** Omit shipping_cost from the session to exercise the metadata fallback. */
	omitShippingCost?: boolean;
	/** Recipient phone as Stripe's `customer_details.phone`; null = never collected. */
	phone?: string | null;
	/** County as Stripe's address `state`; null = Stripe sent none. */
	county?: string | null;
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
				customer_details: {
					email: `client${seq}@example.ro`,
					name: 'Ana Pop',
					...(input.phone === null ? {} : { phone: input.phone ?? '+40712345678' })
				},
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: {
							line1: 'Str. Somnului 10',
							city: 'Cluj-Napoca',
							...(input.county === null ? {} : { state: input.county ?? 'Cluj' }),
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

	it('a courier failure leaves a `failed` row with the reason, no transition, no email; the retry registers exactly one AWB', async () => {
		const order = await orderViaWebhook({});
		const before = courier.shipments.size;
		courier.failNextCreate = new Error('Sameday AWB creation failed (HTTP 400): county unknown');

		const result = await createShipmentForOrder(shipDeps, order.id, ACTOR);
		expect(!result.ok && result.error).toBe('courier');
		expect(!result.ok && result.detail).toContain('HTTP 400');

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('unfulfilled');
		// Two-phase (audit P2 "courier call inside the transaction"): the claim
		// row survives the failure and says why — no AWB, so nothing to mail.
		const [failed] = await shipmentRows(order.id);
		expect(failed.status).toBe('failed');
		expect(failed.awb).toBeNull();
		expect(failed.lastError).toContain('county unknown');
		const kinds = await eventKinds(order.id);
		expect(kinds).toContain('awb-failed');
		expect(kinds).not.toContain('awb-generated');
		expect(
			await db
				.select()
				.from(emailLog)
				.where(
					and(eq(emailLog.toEmail, order.email), eq(emailLog.template, 'shipping-notification'))
				)
		).toHaveLength(0);

		// The retry after the courier recovers: a new row, one AWB, order shipped.
		const retry = await createShipmentForOrder(shipDeps, order.id, ACTOR);
		expect(retry.ok && retry.value.created).toBe(true);
		const rows = await shipmentRows(order.id);
		expect(rows.map((r) => r.status)).toEqual(['failed', 'registered']);
		expect(courier.shipments.size).toBe(before + 1);
		expect((await getShipmentForOrder({ db }, order.id))?.status).toBe('registered');
		const [shipped] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(shipped.fulfillmentStatus).toBe('shipped');
	});
});

// Audit 2026-09-03 P2 "courier call inside the shipment transaction can orphan
// an AWB": the `creating` row is committed BEFORE the courier is called and the
// order row is not locked while the courier works — so a crash mid-call leaves
// a row to recover from and Sameday's AWB is findable by clientInternalReference.
describe('two-phase AWB creation', () => {
	it('commits the creating row first and calls the courier outside the order lock', async () => {
		const order = await orderViaWebhook({});
		const gated = gatedCourier();
		const pending = createShipmentForOrder(
			{ ...shipDeps, courier: gated.courier },
			order.id,
			ACTOR
		);
		try {
			// Visible from another connection while the courier call is in flight.
			const creating = await waitForShipment(order.id, 'creating');
			expect(creating.awb).toBeNull();
			expect(creating.provider).toBe('mock');
			// No lock is held on the order meanwhile: NOWAIT succeeds.
			await db.transaction(async (tx) => {
				await tx.execute(sql`select id from orders where id = ${order.id} for update nowait`);
			});
		} finally {
			gated.release();
		}
		const result = await pending;
		expect(result.ok && result.value.created).toBe(true);
		expect(result.ok && result.value.shipment.status).toBe('registered');
		expect(result.ok && result.value.shipment.awb).toMatch(/^MOCKAWB/);
		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('shipped');
		expect(await shipmentRows(order.id)).toHaveLength(1);
	});

	it('a refund landing during the courier call cancels the fresh AWB; the order stays cancelled', async () => {
		const order = await orderViaWebhook({});
		const gated = gatedCourier();
		const pending = createShipmentForOrder(
			{ ...shipDeps, courier: gated.courier },
			order.id,
			ACTOR
		);
		try {
			await waitForShipment(order.id, 'creating');
			await refundViaWebhook(order);
		} finally {
			gated.release();
		}
		const result = await pending;
		expect(!result.ok && result.error).toBe('order-not-shippable');

		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.status).toBe('refunded');
		expect(after.fulfillmentStatus).toBe('cancelled');
		const rows = await shipmentRows(order.id);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('cancelled');
		expect(rows[0].awb).toMatch(/^MOCKAWB/);
		// The AWB that came back from the courier was cancelled there again.
		expect(courier.cancelled).toContain(rows[0].awb);
		const kinds = await eventKinds(order.id);
		expect(kinds).toContain('awb-generated');
		expect(kinds).toContain('shipment-cancelled');
		expect(
			await db
				.select()
				.from(emailLog)
				.where(
					and(eq(emailLog.toEmail, order.email), eq(emailLog.template, 'shipping-notification'))
				)
		).toHaveLength(0);
	});

	it('two concurrent clicks register exactly one AWB', async () => {
		const order = await orderViaWebhook({});
		const before = courier.shipments.size;
		const results = await Promise.all([
			createShipmentForOrder(shipDeps, order.id, ACTOR),
			createShipmentForOrder(shipDeps, order.id, ACTOR)
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
		expect(await shipmentRows(order.id)).toHaveLength(1);
		expect(courier.shipments.size).toBe(before + 1);
	});

	it('a fresh creating row is returned as-is; a stale one (process died mid-call) is failed and replaced', async () => {
		const order = await orderViaWebhook({});
		await db.insert(shipments).values({
			id: `fresh-${order.id}`,
			orderId: order.id,
			provider: 'mock',
			status: 'creating',
			awb: null
		});
		const fresh = await createShipmentForOrder(shipDeps, order.id, ACTOR);
		expect(fresh.ok && fresh.value.created).toBe(false);
		expect(fresh.ok && fresh.value.shipment.status).toBe('creating');
		expect(await shipmentRows(order.id)).toHaveLength(1);

		// Ten minutes later with no outcome: the claim is dead, take over.
		const later = new Date(Date.now() + 10 * 60_000);
		const replaced = await createShipmentForOrder(shipDeps, order.id, ACTOR, { now: later });
		expect(replaced.ok && replaced.value.created).toBe(true);
		const rows = await shipmentRows(order.id);
		expect(rows.map((r) => r.status)).toEqual(['failed', 'registered']);
		expect(rows[0].lastError).toMatch(/no courier answer/i);
		expect(await eventKinds(order.id)).toContain('awb-failed');
	});
});

describe('sync backoff (pure)', () => {
	it('doubles from the base and caps', () => {
		expect(syncBackoffMs(1)).toBe(SHIPMENT_SYNC_BACKOFF_BASE_MS);
		expect(syncBackoffMs(2)).toBe(2 * SHIPMENT_SYNC_BACKOFF_BASE_MS);
		expect(syncBackoffMs(3)).toBe(4 * SHIPMENT_SYNC_BACKOFF_BASE_MS);
		expect(syncBackoffMs(20)).toBe(SHIPMENT_SYNC_BACKOFF_MAX_MS);
		expect(syncBackoffMs(0)).toBe(SHIPMENT_SYNC_BACKOFF_BASE_MS);
	});
});

// Audit 2026-09-03 P1 "Sameday adapter cannot produce a deliverable AWB":
// Sameday requires a recipient phone and county. Before FIX-11 the phone was
// never collected, the county silently fell back to the city name and the
// courier's 400 was discarded — every live "Generează AWB" would fail
// opaquely. The service must refuse BEFORE calling the courier, naming the
// missing fields, and pass both through when present.
describe('recipient data is checked before the courier is called', () => {
	it('an order without a recipient phone is refused and the courier is never called', async () => {
		const order = await orderViaWebhook({ phone: null });
		const before = courier.shipments.size;

		const result = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(!result.ok && result.error).toBe('missing-recipient-data');
		expect(!result.ok && result.detail).toContain('phone');

		expect(courier.shipments.size).toBe(before);
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toHaveLength(
			0
		);
		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('unfulfilled');
		expect((await eventKinds(order.id)).includes('awb-generated')).toBe(false);
	});

	it('names every missing field — phone and county together, never the city as county', async () => {
		const order = await orderViaWebhook({ phone: null, county: null });
		const result = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(!result.ok && result.error).toBe('missing-recipient-data');
		expect(!result.ok && result.detail?.split(', ').sort()).toEqual(['county', 'phone']);
	});

	it('with phone and county the courier request carries both, keyed on the order id', async () => {
		const order = await orderViaWebhook({ phone: '+40 723 000 111', county: 'Cluj' });
		// The webhook persisted Stripe's customer_details.phone into the address.
		expect(order.shippingAddress?.phone).toBe('+40 723 000 111');

		const result = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const recorded = courier.shipments.get(result.value.shipment.awb ?? '');
		expect(recorded?.request.recipient.phone).toBe('+40 723 000 111');
		expect(recorded?.request.recipient.address.state).toBe('Cluj');
		expect(recorded?.request.recipient.address.city).toBe('Cluj-Napoca');
		expect(recorded?.request.reference).toBe(order.id);
	});
});

describe('cron shipment-status sync', () => {
	it('is a no-op with nothing in flight', async () => {
		// Everything registered so far in THIS block's fresh sub-state: move all
		// existing in-flight rows out of the way by syncing against reality.
		await parkInFlight();
		const result = await syncShipmentStatuses({ db, courier });
		expect(result).toEqual({ polled: 0, updated: 0, errors: 0 });
	});

	it('updates changed statuses, transitions fulfillment, and is idempotent', async () => {
		const order = await orderViaWebhook({});
		const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		if (!created.ok || !created.value.shipment.awb) throw new Error('shipment failed');
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
		await parkInFlight();
	});

	it('a courier lookup failure skips the row and keeps the run alive', async () => {
		const order = await orderViaWebhook({});
		const created = await createShipmentForOrder(shipDeps, order.id, 'admin@example.ro');
		if (!created.ok) throw new Error('shipment failed');
		// Simulate a courier-side unknown: delete it from the mock's memory.
		courier.shipments.delete(created.value.shipment.awb ?? '');

		const result = await syncShipmentStatuses({ db, courier });
		expect(result.polled).toBe(1);
		expect(result.updated).toBe(0);
		await parkInFlight();
	});
});

// Audit 2026-09-03 P1 "Shipment-sync starvation": a row whose tracking call
// throws kept its head-of-queue position, so a few poisoned AWBs stopped every
// other shipment from ever being polled, and an auth failure failed every row
// hourly with a console.log. Rows must rotate with backoff, keep their error,
// and an auth failure must abort the run loudly.
describe('shipment-sync rotation and health', () => {
	/** Two registered shipments, A older-synced than B, everything else parked. */
	async function pair(): Promise<{
		a: ShipmentRow;
		b: ShipmentRow;
		orderA: OrderRow;
		orderB: OrderRow;
	}> {
		await parkInFlight();
		const orderA = await orderViaWebhook({});
		const orderB = await orderViaWebhook({});
		const a = await createShipmentForOrder(shipDeps, orderA.id, ACTOR);
		const b = await createShipmentForOrder(shipDeps, orderB.id, ACTOR);
		if (!a.ok || !b.ok) throw new Error('shipment setup failed');
		// A was synced an hour ago, B just now: oldest-synced first, so A leads.
		await db
			.update(shipments)
			.set({ lastSyncedAt: new Date(Date.now() - 3_600_000) })
			.where(eq(shipments.id, a.value.shipment.id));
		await db
			.update(shipments)
			.set({ lastSyncedAt: new Date() })
			.where(eq(shipments.id, b.value.shipment.id));
		return { a: await row(a.value.shipment.id), b: await row(b.value.shipment.id), orderA, orderB };
	}

	async function row(id: string): Promise<ShipmentRow> {
		const [r] = await db.select().from(shipments).where(eq(shipments.id, id));
		return r;
	}

	it('REGRESSION: a throwing row does not block the next row; error_count and backoff advance', async () => {
		const { a, b, orderA } = await pair();
		courier.trackFailures.set(a.awb!, new Error('Sameday status lookup failed (HTTP 500): boom'));
		courier.setTrackingStatus(b.awb!, 'in-transit');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		// Batch of ONE: before the fix A stayed at the head forever and B starved.
		const t0 = new Date();
		const first = await syncShipmentStatuses({ db, courier }, { limit: 1, now: t0 });
		expect(first).toEqual({ polled: 1, updated: 0, errors: 1 });
		let rowA = await row(a.id);
		expect(rowA.status).toBe('registered');
		expect(rowA.errorCount).toBe(1);
		expect(rowA.lastError).toContain('boom');
		expect(rowA.lastSyncedAt?.getTime()).toBe(t0.getTime());
		expect(rowA.nextSyncAt!.getTime()).toBe(t0.getTime() + syncBackoffMs(1));
		expect(await eventKinds(orderA.id)).toContain('shipment-sync-error');
		expect(await shipmentSyncHealth({ db })).toMatchObject({ failing: 1 });

		// Next run: A is backed off, so the batch of one reaches B.
		const t1 = new Date(t0.getTime() + 60_000);
		const second = await syncShipmentStatuses({ db, courier }, { limit: 1, now: t1 });
		expect(second).toEqual({ polled: 1, updated: 1, errors: 0 });
		expect((await row(b.id)).status).toBe('in-transit');
		expect((await row(a.id)).errorCount).toBe(1);

		// Once the backoff elapsed A is retried; still failing → longer backoff.
		const t2 = new Date(t0.getTime() + syncBackoffMs(1) + 1_000);
		const third = await syncShipmentStatuses({ db, courier }, { limit: 1, now: t2 });
		expect(third).toEqual({ polled: 1, updated: 0, errors: 1 });
		rowA = await row(a.id);
		expect(rowA.errorCount).toBe(2);
		expect(rowA.nextSyncAt!.getTime()).toBe(t2.getTime() + syncBackoffMs(2));
		expect(syncBackoffMs(2)).toBeGreaterThan(syncBackoffMs(1));
		expect((await eventKinds(orderA.id)).filter((k) => k === 'shipment-sync-error')).toHaveLength(
			2
		);

		// The courier recovers: the row heals on the next successful poll.
		courier.trackFailures.delete(a.awb!);
		const t3 = new Date(t2.getTime() + syncBackoffMs(2) + 1_000);
		await syncShipmentStatuses({ db, courier }, { limit: 5, now: t3 });
		rowA = await row(a.id);
		expect(rowA.errorCount).toBe(0);
		expect(rowA.lastError).toBeNull();
		expect(rowA.nextSyncAt).toBeNull();
		expect(await shipmentSyncHealth({ db })).toMatchObject({ failing: 0 });
	});

	it('an auth error aborts the run at error level, reports it, and leaves the other rows untouched', async () => {
		const { a, b, orderA } = await pair();
		courier.trackFailures.set(
			a.awb!,
			new CourierAuthError('Sameday authentication failed (HTTP 401)')
		);
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

		const t0 = new Date();
		const result = await syncShipmentStatuses({ db, courier }, { limit: 25, now: t0 });
		expect(result).toEqual({ polled: 1, updated: 0, errors: 1, aborted: 'auth' });
		expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/credentials|authentication/i));

		// B was not polled; A records the failure (visible on the dashboard)
		// but is NOT backed off: the credentials are at fault, not the AWB.
		expect((await row(b.id)).lastSyncedAt?.getTime()).toBe(b.lastSyncedAt?.getTime());
		const rowA = await row(a.id);
		expect(rowA.errorCount).toBe(1);
		expect(rowA.lastError).toContain('authentication failed');
		expect(rowA.nextSyncAt).toBeNull();
		expect(await eventKinds(orderA.id)).toContain('shipment-sync-error');
		expect(await shipmentSyncHealth({ db })).toMatchObject({
			failing: 1,
			latestError: expect.stringContaining('authentication failed')
		});

		// Credentials fixed: the next run polls both and clears the flag.
		courier.trackFailures.delete(a.awb!);
		const again = await syncShipmentStatuses(
			{ db, courier },
			{ now: new Date(t0.getTime() + 60_000) }
		);
		expect(again).toEqual({ polled: 2, updated: 0, errors: 0 });
		expect((await row(a.id)).errorCount).toBe(0);
		expect(await shipmentSyncHealth({ db })).toMatchObject({ failing: 0 });
	});
});

// Audit 2026-09-03 P1 "Courier-cancelled AWB is a dead end": the order stayed
// `shipped` forever and the cancelled row blocked any replacement AWB.
describe('courier-cancelled AWB (outside the refund path)', () => {
	it('moves the order back to packed, marks the row cancelled, and allows a replacement AWB', async () => {
		await parkInFlight();
		const order = await orderViaWebhook({});
		const first = await createShipmentForOrder(shipDeps, order.id, ACTOR);
		if (!first.ok) throw new Error('shipment failed');
		const oldAwb = first.value.shipment.awb!;
		courier.setTrackingStatus(oldAwb, 'cancelled');

		const result = await syncShipmentStatuses({ db, courier });
		expect(result).toEqual({ polled: 1, updated: 1, errors: 0 });
		const [row] = await shipmentRows(order.id);
		expect(row.status).toBe('cancelled');
		let [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('packed');
		expect(await eventKinds(order.id)).toContain('awb-cancelled-externally');
		const back = await db
			.select()
			.from(orderEvents)
			.where(
				and(
					eq(orderEvents.orderId, order.id),
					eq(orderEvents.kind, 'fulfillment-transition'),
					eq(orderEvents.fromStatus, 'shipped'),
					eq(orderEvents.toStatus, 'packed')
				)
			);
		expect(back).toHaveLength(1);
		expect(back[0].actor).toBe(SHIPMENT_SYNC_ACTOR);
		// With no replacement yet, the detail page still shows the latest row.
		expect((await getShipmentForOrder({ db }, order.id))?.id).toBe(row.id);
		// The cancelled row leaves the polling set.
		expect((await syncShipmentStatuses({ db, courier })).polled).toBe(0);

		// A replacement AWB: new row, order shipped again, old row untouched.
		const second = await createShipmentForOrder(shipDeps, order.id, ACTOR);
		expect(second.ok && second.value.created).toBe(true);
		const newAwb = second.ok ? second.value.shipment.awb! : '';
		expect(newAwb).not.toBe(oldAwb);
		const rows = await shipmentRows(order.id);
		expect(rows.map((r) => r.status)).toEqual(['cancelled', 'registered']);
		[after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('shipped');
		expect((await getShipmentForOrder({ db }, order.id))?.awb).toBe(newAwb);
		// One shipping email per AWB: the replacement gets its own.
		expect(
			await db
				.select()
				.from(emailLog)
				.where(eq(emailLog.idempotencyKey, `shipping-notification:${newAwb}`))
		).toHaveLength(1);

		// The refund rule acts on the ACTIVE row: the replacement is cancelled with the courier.
		await refundViaWebhook(order);
		expect(courier.cancelled).toContain(newAwb);
		expect(courier.cancelled).not.toContain(oldAwb);
		[after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.fulfillmentStatus).toBe('returned');
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
		if (!created.ok || !created.value.shipment.awb) throw new Error('shipment failed');
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
		if (!created.ok || !created.value.shipment.awb) throw new Error('shipment failed');
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
