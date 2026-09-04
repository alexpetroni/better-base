import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Stripe from 'stripe';
import { ISSUER_ADDRESS_SETTINGS } from '../../../../tests/helpers/issuer-settings.ts';
import { createDb, type Db } from '../../db/client.ts';
import { eraseSubscriberData, ANONYMIZED_EMAIL } from '../gdpr/erase.ts';
import { createEmailSender } from '../email/service.ts';
import { siteSettings } from '../settings/schema.ts';
import type { SettingJsonValue, SettingKey } from '../settings/registry.ts';
import { buildBuyerCompanyMetadata, buildCartMetadata } from '../shop/checkout.ts';
import { orderEvents, orderItems, orders, products } from '../shop/schema.ts';
import {
	listOrders,
	processStripeEvent,
	verifyStripeEvent,
	type WebhookDeps
} from '../shop/webhook.ts';
import { loadInvoiceModel } from './documents.ts';
import { renderEFacturaXml } from './efactura.ts';
import { validateEFacturaXml } from './efactura-validate.ts';
import { invoiceLines, invoices, invoiceSeries } from './schema.ts';
import {
	composeDisplayNumber,
	ensureInvoicesForOrder,
	issuePartialStornoForOrder
} from './service.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh): the fiscal record end-to-end — gapless numbering under a real race,
// automatic idempotent issuance through the webhook, storno on refund,
// DB-level immutability, failure + one-click retry, and the GDPR/retention
// split. Stripe never leaves the process: payloads are signed offline.

const WEBHOOK_SECRET = 'whsec_invoice_spec_secret';
const stripeSigner = new Stripe('sk_test_offline_signing_only');

let db: Db;
let webhookDeps: WebhookDeps;

/** The complete, valid issuer configuration the tests start from. */
const ISSUER_SETTINGS: Partial<Record<SettingKey, SettingJsonValue>> = {
	'company.legalName': 'Better Sleep SRL',
	'company.cui': 'RO12345676',
	'company.vatRegistered': true,
	'company.regCom': 'J40/1234/2025',
	'company.address': 'Str. Somnului 10, București',
	...ISSUER_ADDRESS_SETTINGS,
	'company.contactEmail': 'contact@better-sleep.ro',
	'company.iban': 'RO49AAAA1B31007593840000',
	'invoice.seriesPrefix': 'BSL',
	'invoice.nextNumber': 101,
	'invoice.issuerPlace': 'București',
	// The effective-dated standard rate (FIX-12): one line per rate change.
	'invoice.vatStandardRates': '2025-08-01 21'
};

async function setSettings(entries: Partial<Record<SettingKey, SettingJsonValue>>): Promise<void> {
	const rows = Object.entries(entries).map(([key, value]) => ({ key, value }));
	await db
		.insert(siteSettings)
		.values(rows)
		.onConflictDoUpdate({ target: siteSettings.key, set: { value: sql`excluded.value` } });
}

let seq = 0;

async function insertPaidOrder(input?: {
	status?: 'paid' | 'refunded' | 'pending';
	paymentIntent?: string;
	/** Per-item VAT rate snapshot (FIX-12); omitted = the standard rate at the order date. */
	items?: Array<{ name: string; qty: number; priceCents: number; vatRateBp?: number | null }>;
	/** The order (= chargeability) date; defaults to now. */
	createdAt?: Date;
	refundedCents?: number;
	shippingAddress?: Record<string, string>;
	customerName?: string;
	billingCompany?: Record<string, unknown>;
	paymentMethod?: string;
}) {
	const id = `inv-order-${++seq}`;
	const items = input?.items ?? [{ name: 'Pernă memory foam', qty: 1, priceCents: 4990 }];
	const [order] = await db
		.insert(orders)
		.values({
			id,
			email: `client-${seq}@example.ro`,
			stripeSessionId: `cs_${id}`,
			stripePaymentIntent: input?.paymentIntent ?? null,
			amountTotalCents: items.reduce((sum, item) => sum + item.qty * item.priceCents, 0),
			currency: 'ron',
			status: input?.status ?? 'paid',
			shippingAddress: input?.shippingAddress ?? {
				name: 'Ana Pop',
				line1: 'Str. Exemplu 1',
				city: 'Cluj-Napoca'
			},
			...(input?.customerName !== undefined ? { customerName: input.customerName } : {}),
			...(input?.billingCompany ? { billingCompany: input.billingCompany } : {}),
			...(input?.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
			...(input?.createdAt ? { createdAt: input.createdAt } : {}),
			...(input?.refundedCents !== undefined ? { refundedCents: input.refundedCents } : {})
		})
		.returning();
	await db.insert(orderItems).values(
		items.map((item, i) => ({
			id: `${id}-item-${i}`,
			orderId: id,
			name: item.name,
			qty: item.qty,
			priceCents: item.priceCents,
			vatRateBp: item.vatRateBp ?? null
		}))
	);
	return order;
}

interface SessionOverrides {
	id: string;
	cart: Array<{ productId: string; qty: number; priceCents: number }>;
	amountTotal: number;
	paymentIntent?: string;
	email?: string;
	eventId?: string;
	company?: { name: string; cui?: string; regCom?: string };
}

function completedSessionEvent(overrides: SessionOverrides): string {
	return JSON.stringify({
		id: overrides.eventId ?? `evt_${overrides.id}`,
		object: 'event',
		type: 'checkout.session.completed',
		api_version: '2026-01-01',
		created: 1783000000,
		data: {
			object: {
				id: overrides.id,
				object: 'checkout.session',
				amount_total: overrides.amountTotal,
				currency: 'ron',
				payment_intent: overrides.paymentIntent ?? `pi_${overrides.id}`,
				payment_status: 'paid',
				customer_details: { email: overrides.email ?? 'client@example.ro', name: 'Ana Pop' },
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: { line1: 'Str. Somnului 10', city: 'Cluj-Napoca', country: 'RO' }
					}
				},
				metadata: {
					cart: buildCartMetadata(overrides.cart),
					...(overrides.company ? { company: buildBuyerCompanyMetadata(overrides.company) } : {})
				}
			}
		}
	});
}

function refundedChargeEvent(overrides: {
	eventId: string;
	chargeId: string;
	paymentIntent: string;
}): string {
	return JSON.stringify({
		id: overrides.eventId,
		object: 'event',
		type: 'charge.refunded',
		data: {
			object: {
				id: overrides.chargeId,
				object: 'charge',
				payment_intent: overrides.paymentIntent
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

async function invoicesForOrder(orderId: string) {
	return db
		.select()
		.from(invoices)
		.where(eq(invoices.orderId, orderId))
		.orderBy(asc(invoices.number));
}

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
	webhookDeps = {
		db,
		email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
		siteName: 'Better Sleep'
	};
	await db.insert(products).values({
		id: 'inv-prod-1',
		slug: 'perna-invoice-spec',
		name: 'Pernă memory foam',
		priceCents: 4990,
		currency: 'ron',
		status: 'active'
	});
});

beforeEach(async () => {
	await setSettings(ISSUER_SETTINGS);
});

afterAll(async () => {
	await db?.$client.end();
});

describe('gapless race-free numbering', () => {
	it('N concurrent issuances yield N consecutive numbers — no duplicates, no gaps', async () => {
		const N = 8;
		const orderRows = [];
		for (let i = 0; i < N; i++) orderRows.push(await insertPaidOrder({}));

		// The race a naive `MAX(number)+1` cannot survive: all N allocate at
		// once. Duplicates would either collide on the (series, number) unique
		// index (failing some issuances) or repeat a number in the result.
		const results = await Promise.all(
			orderRows.map((order) => ensureInvoicesForOrder({ db }, order.id, 'race-test'))
		);
		for (const result of results) expect(result.ok).toBe(true);

		const numbers = results.map((r) => (r.ok ? r.value.invoice.number : -1)).sort((a, b) => a - b);
		// Consecutive from the configured start (invoice.nextNumber = 101).
		expect(numbers).toEqual(Array.from({ length: N }, (_, i) => 101 + i));

		// The next issuance continues the sequence.
		const next = await ensureInvoicesForOrder({ db }, (await insertPaidOrder({})).id, 'race-test');
		expect(next.ok && next.value.invoice.number).toBe(101 + N);
		expect(next.ok && next.value.invoice.displayNumber).toBe(composeDisplayNumber('BSL', 109));
	});

	it('the series row is the authority once created: settings edits do not renumber', async () => {
		await setSettings({ 'invoice.nextNumber': 1 });
		const result = await ensureInvoicesForOrder({ db }, (await insertPaidOrder({})).id, 'test');
		// Still continues from the live counter, not the (stale) setting.
		expect(result.ok && result.value.invoice.number).toBeGreaterThan(101);
	});
});

describe('issuance snapshot', () => {
	it('copies issuer + buyer + per-line VAT into the invoice, independent of later edits', async () => {
		const order = await insertPaidOrder({
			items: [
				{ name: 'Pernă memory foam', qty: 2, priceCents: 4990 },
				{ name: 'Mască de somn', qty: 1, priceCents: 12550 }
			]
		});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'snapshot-test');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const invoice = result.value.invoice;

		expect(invoice).toMatchObject({
			kind: 'invoice',
			series: 'BSL',
			displayNumber: composeDisplayNumber('BSL', invoice.number),
			orderId: order.id,
			currency: 'ron',
			issuerName: 'Better Sleep SRL',
			issuerCui: 'RO12345676',
			issuerVatRegistered: true,
			issuerRegCom: 'J40/1234/2025',
			issuerAddress: 'Str. Somnului 10, București',
			issuerPlace: 'București',
			issuerIban: 'RO49AAAA1B31007593840000',
			buyerName: 'Ana Pop',
			buyerEmail: order.email,
			// 21% extracted per line: 9980→1732 VAT, 12550→2178 VAT.
			netTotalCents: 8248 + 10372,
			vatTotalCents: 1732 + 2178,
			grossTotalCents: 22530,
			mentions: ''
		});
		expect(invoice.buyerAddress).toContain('Str. Exemplu 1');
		expect(invoice.dueAt).toEqual(invoice.issuedAt);

		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, invoice.id))
			.orderBy(asc(invoiceLines.position));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			position: 1,
			description: 'Pernă memory foam',
			qty: 2,
			unitPriceCents: 4990,
			vatRateBp: 2100,
			grossCents: 9980,
			vatCents: 1732,
			netCents: 8248
		});

		// Editing settings AFTER issuance must not rewrite the document.
		await setSettings({ 'company.legalName': 'Renamed SRL' });
		const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
		expect(after.issuerName).toBe('Better Sleep SRL');
	});

	it('VAT-unregistered issuer: 0% lines plus the required mention', async () => {
		// A neplătitor states its CUI without the RO prefix (FIX-12 prefix rule).
		await setSettings({ 'company.vatRegistered': false, 'company.cui': '12345676' });
		const order = await insertPaidOrder({});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'neplatitor-test');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.invoice.vatTotalCents).toBe(0);
		expect(result.value.invoice.netTotalCents).toBe(result.value.invoice.grossTotalCents);
		expect(result.value.invoice.issuerVatRegistered).toBe(false);
		expect(result.value.invoice.mentions).toContain('Neplătitor de TVA');
		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, result.value.invoice.id));
		expect(lines[0].vatRateBp).toBe(0);
		expect(lines[0].vatCents).toBe(0);
	});
});

describe('automatic idempotent issuance (webhook path)', () => {
	it('a paid order gets exactly one invoice; redeliveries and resends issue none', async () => {
		const cart = [{ productId: 'inv-prod-1', qty: 1, priceCents: 4990 }];
		const payload = completedSessionEvent({
			id: 'cs_auto_invoice',
			cart,
			amountTotal: 4990,
			company: { name: 'Client SRL', cui: 'RO999885', regCom: 'J12/99/2020' }
		});
		expect((await deliver(payload)).kind).toBe('order-created');

		const [order] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_auto_invoice'));
		// The B2B capture flowed through metadata onto the order…
		expect(order.billingCompany).toEqual({
			name: 'Client SRL',
			cui: 'RO999885',
			regCom: 'J12/99/2020'
		});

		let docs = await invoicesForOrder(order.id);
		expect(docs).toHaveLength(1);
		expect(docs[0].kind).toBe('invoice');
		// …and into the invoice snapshot.
		expect(docs[0].buyerCompanyName).toBe('Client SRL');
		expect(docs[0].buyerCompanyCui).toBe('RO999885');
		expect(docs[0].buyerName).toBe('Client SRL');

		// The issuance is on the order's audit trail.
		const trail = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
		expect(trail.filter((e) => e.kind === 'invoice-issued')).toHaveLength(1);
		expect(trail.filter((e) => e.kind === 'invoice-issued')[0].note).toBe(docs[0].displayNumber);

		// Redelivery of the SAME event id: ledger short-circuits, no new invoice.
		expect((await deliver(payload)).kind).toBe('duplicate-event');
		// Same session under a NEW event id (dashboard resend): still none.
		const resend = completedSessionEvent({
			id: 'cs_auto_invoice',
			cart,
			amountTotal: 4990,
			eventId: 'evt_cs_auto_invoice_resend'
		});
		expect((await deliver(resend)).kind).toBe('duplicate-session');

		docs = await invoicesForOrder(order.id);
		expect(docs).toHaveLength(1);
	});
});

describe('storno on refund', () => {
	it('a refund issues one storno referencing the untouched original', async () => {
		const cart = [{ productId: 'inv-prod-1', qty: 2, priceCents: 4990 }];
		await deliver(
			completedSessionEvent({
				id: 'cs_storno',
				cart,
				amountTotal: 9980,
				paymentIntent: 'pi_storno_me'
			})
		);
		const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_storno'));
		const [original] = await invoicesForOrder(order.id);
		expect(original.kind).toBe('invoice');

		const refund = refundedChargeEvent({
			eventId: 'evt_storno_refund',
			chargeId: 'ch_storno',
			paymentIntent: 'pi_storno_me'
		});
		expect((await deliver(refund)).kind).toBe('refund-marked');

		const docs = await invoicesForOrder(order.id);
		expect(docs).toHaveLength(2);
		const storno = docs.find((d) => d.kind === 'storno')!;
		expect(storno.stornoOfInvoiceId).toBe(original.id);
		expect(storno.series).toBe(original.series);
		expect(storno.number).toBeGreaterThan(original.number);
		expect(storno.netTotalCents).toBe(-original.netTotalCents);
		expect(storno.vatTotalCents).toBe(-original.vatTotalCents);
		expect(storno.grossTotalCents).toBe(-original.grossTotalCents);

		// Storno lines negate the ORIGINAL's stored amounts exactly.
		const stornoLines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, storno.id));
		const originalLines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, original.id));
		expect(stornoLines).toHaveLength(originalLines.length);
		expect(stornoLines[0]).toMatchObject({
			qty: -originalLines[0].qty,
			unitPriceCents: originalLines[0].unitPriceCents,
			netCents: -originalLines[0].netCents,
			vatCents: -originalLines[0].vatCents,
			grossCents: -originalLines[0].grossCents
		});

		// The original row is bit-for-bit what it was before the refund.
		const [originalAfter] = await db.select().from(invoices).where(eq(invoices.id, original.id));
		expect(originalAfter).toEqual(original);

		// Redelivered refund: still exactly one storno.
		expect((await deliver(refund)).kind).toBe('duplicate-event');
		expect(await invoicesForOrder(order.id)).toHaveLength(2);
	});
});

describe('immutability (DB level)', () => {
	/** The DB must refuse — and say WHY (drizzle wraps the pg error in `cause`). */
	async function expectAppendOnlyRejection(run: Promise<unknown>): Promise<void> {
		let caught: unknown;
		try {
			await run;
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error & { cause?: { message?: string } };
		expect(`${error.message} ${error.cause?.message ?? ''}`).toMatch(/append-only/);
	}

	it('UPDATE and DELETE on an issued invoice and its lines are rejected by the database', async () => {
		const order = await insertPaidOrder({});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'immutability-test');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const id = result.value.invoice.id;

		await expectAppendOnlyRejection(
			db.execute(sql`update invoices set buyer_name = 'Rewritten' where id = ${id}`)
		);
		await expectAppendOnlyRejection(db.execute(sql`delete from invoices where id = ${id}`));
		await expectAppendOnlyRejection(
			db.execute(sql`update invoice_lines set description = 'x' where invoice_id = ${id}`)
		);
		await expectAppendOnlyRejection(
			db.execute(sql`delete from invoice_lines where invoice_id = ${id}`)
		);

		// An invoiced order cannot be deleted from under its invoice either.
		await expect(db.execute(sql`delete from orders where id = ${order.id}`)).rejects.toThrow();

		// Drizzle-level attempts hit the same wall (service layer has no
		// update/delete API; this guards against future raw queries too).
		await expectAppendOnlyRejection(
			db.update(invoices).set({ buyerName: 'Rewritten' }).where(eq(invoices.id, id))
		);
		await expectAppendOnlyRejection(db.delete(invoices).where(eq(invoices.id, id)));

		// Still there, unchanged.
		const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
		expect(row.buyerName).not.toBe('Rewritten');
	});
});

describe('issuance failure and one-click retry', () => {
	it('placeholder settings fail issuance WITHOUT losing the order; retry succeeds after the fix', async () => {
		// Break the issuer configuration the way a fresh deployment is broken:
		// required keys missing entirely.
		await db.delete(siteSettings);

		const cart = [{ productId: 'inv-prod-1', qty: 1, priceCents: 4990 }];
		const payload = completedSessionEvent({ id: 'cs_fail_retry', cart, amountTotal: 4990 });
		expect((await deliver(payload)).kind).toBe('order-created');

		const [order] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_fail_retry'));
		expect(order.status).toBe('paid');
		expect(await invoicesForOrder(order.id)).toHaveLength(0);

		// The failure is recorded on the trail, naming the missing settings…
		const failures = (
			await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id))
		).filter((e) => e.kind === 'invoice-failed');
		expect(failures).toHaveLength(1);
		expect(failures[0].note).toContain('settings-incomplete');
		expect(failures[0].note).toContain('invoice.seriesPrefix');

		// …and the order surfaces in the admin work queue's invoice filter.
		const queue = await listOrders({ db }, 'invoice-missing');
		expect(queue.map((o) => o.id)).toContain(order.id);
		expect(queue.find((o) => o.id === order.id)?.invoiceNumber).toBeNull();

		// A retry with the settings still broken records another failure.
		const stillBroken = await ensureInvoicesForOrder({ db }, order.id, 'admin@example.ro');
		expect(!stillBroken.ok && stillBroken.error).toBe('settings-incomplete');

		// Operator completes the settings; the one-click retry issues.
		await setSettings(ISSUER_SETTINGS);
		const retried = await ensureInvoicesForOrder({ db }, order.id, 'admin@example.ro');
		expect(retried.ok).toBe(true);
		if (!retried.ok) return;
		expect(retried.value.invoice.kind).toBe('invoice');

		// Idempotent: a second click issues nothing new.
		const again = await ensureInvoicesForOrder({ db }, order.id, 'admin@example.ro');
		expect(again.ok && again.value.invoice.id).toBe(retried.value.invoice.id);
		expect(await invoicesForOrder(order.id)).toHaveLength(1);

		// And the order leaves the invoice work queue.
		const queueAfter = await listOrders({ db }, 'invoice-missing');
		expect(queueAfter.map((o) => o.id)).not.toContain(order.id);
	});

	it('refund without an invoice records storno-failed; the retry issues invoice AND storno', async () => {
		await db.delete(siteSettings);
		const cart = [{ productId: 'inv-prod-1', qty: 1, priceCents: 4990 }];
		await deliver(
			completedSessionEvent({
				id: 'cs_refund_no_invoice',
				cart,
				amountTotal: 4990,
				paymentIntent: 'pi_refund_no_invoice'
			})
		);
		expect(
			(
				await deliver(
					refundedChargeEvent({
						eventId: 'evt_refund_no_invoice',
						chargeId: 'ch_no_invoice',
						paymentIntent: 'pi_refund_no_invoice'
					})
				)
			).kind
		).toBe('refund-marked');

		const [order] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_refund_no_invoice'));
		const trail = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
		expect(trail.some((e) => e.kind === 'storno-failed')).toBe(true);
		// A refunded order without documents sits in the invoice queue.
		expect((await listOrders({ db }, 'invoice-missing')).map((o) => o.id)).toContain(order.id);

		await setSettings(ISSUER_SETTINGS);
		const retried = await ensureInvoicesForOrder({ db }, order.id, 'admin@example.ro');
		expect(retried.ok).toBe(true);
		if (!retried.ok) return;
		expect(retried.value.storno?.stornoOfInvoiceId).toBe(retried.value.invoice.id);
		expect(await invoicesForOrder(order.id)).toHaveLength(2);
		expect((await listOrders({ db }, 'invoice-missing')).map((o) => o.id)).not.toContain(order.id);
	});
});

describe('GDPR erasure vs accounting retention', () => {
	it('erasure anonymizes the order but leaves the invoice snapshot readable', async () => {
		const email = 'gdpr-invoice@example.ro';
		const cart = [{ productId: 'inv-prod-1', qty: 1, priceCents: 4990 }];
		await deliver(
			completedSessionEvent({
				id: 'cs_gdpr_invoice',
				cart,
				amountTotal: 4990,
				email,
				company: { name: 'PFA Ana Pop', cui: 'RO555444' }
			})
		);
		const [order] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_gdpr_invoice'));
		const [invoice] = await invoicesForOrder(order.id);
		expect(invoice.buyerEmail).toBe(email);

		const erased = await eraseSubscriberData({ db }, email);
		expect(erased.ok).toBe(true);
		if (!erased.ok) return;
		expect(erased.value.ordersAnonymized).toBe(1);
		// The erase run reports what it legally had to keep.
		expect(erased.value.invoicesRetained).toBe(1);

		// The ORDER carries no personal data anymore…
		const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(orderAfter.email).toBe(ANONYMIZED_EMAIL);
		expect(orderAfter.shippingAddress).toBeNull();
		expect(orderAfter.billingCompany).toBeNull();

		// …while the INVOICE snapshot is intact and readable (legal retention,
		// GDPR art. 17(3)(b) — see modules/invoice/README.md).
		const [invoiceAfter] = await db
			.select()
			.from(invoices)
			.where(and(eq(invoices.orderId, order.id), eq(invoices.kind, 'invoice')));
		expect(invoiceAfter).toEqual(invoice);
		expect(invoiceAfter.buyerEmail).toBe(email);
		expect(invoiceAfter.buyerName).toBe('PFA Ana Pop');
	});
});

describe('series bookkeeping', () => {
	it('numbering state survives in invoice_series, one row per series', async () => {
		const rows = await db.select().from(invoiceSeries);
		expect(rows).toHaveLength(1);
		expect(rows[0].series).toBe('BSL');
		expect(rows[0].nextNumber).toBeGreaterThan(101);
	});
});

describe('VAT model (FIX-12): per-product rates, the order-date standard rate', () => {
	it('two products at 21% and 11% → lines at their own rates, two tax subtotals, integer totals reconcile', async () => {
		const order = await insertPaidOrder({
			items: [
				{ name: 'Pernă memory foam', qty: 1, priceCents: 4990 }, // standard rate
				{ name: 'Ceai de seară', qty: 2, priceCents: 1150, vatRateBp: 1100 } // reduced (food)
			]
		});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'vat-model-test');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const invoice = result.value.invoice;

		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, invoice.id))
			.orderBy(asc(invoiceLines.position));
		expect(lines.map((line) => line.vatRateBp)).toEqual([2100, 1100]);
		// 4990 @ 21 %: VAT 866 / net 4124; 2300 @ 11 %: 2300·1100/11100 = 227.9 → 228 / net 2072.
		expect(lines[0]).toMatchObject({ grossCents: 4990, vatCents: 866, netCents: 4124 });
		expect(lines[1]).toMatchObject({ grossCents: 2300, vatCents: 228, netCents: 2072 });
		expect(invoice).toMatchObject({
			netTotalCents: 4124 + 2072,
			vatTotalCents: 866 + 228,
			grossTotalCents: 7290
		});
		expect(invoice.netTotalCents + invoice.vatTotalCents).toBe(invoice.grossTotalCents);
		expect(invoice.grossTotalCents).toBe(order.amountTotalCents);

		// The e-Factura XML carries ONE TaxSubtotal per rate and still validates.
		const model = (await loadInvoiceModel({ db }, invoice.id))!;
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(2);
		expect(xml).toContain('<cbc:Percent>21</cbc:Percent>');
		expect(xml).toContain('<cbc:Percent>11</cbc:Percent>');
	});

	it('a retry issued after a standard-rate change uses the rate in force on the ORDER date', async () => {
		// The schedule changes on 2026-07-01; one order before it, one after.
		await setSettings({ 'invoice.vatStandardRates': '2025-08-01 21\n2026-07-01 19' });
		const before = await insertPaidOrder({ createdAt: new Date('2026-06-15T10:00:00Z') });
		const after = await insertPaidOrder({ createdAt: new Date('2026-07-02T10:00:00Z') });

		const issuedBefore = await ensureInvoicesForOrder({ db }, before.id, 'rate-change-test');
		const issuedAfter = await ensureInvoicesForOrder({ db }, after.id, 'rate-change-test');
		expect(issuedBefore.ok && issuedAfter.ok).toBe(true);
		if (!issuedBefore.ok || !issuedAfter.ok) return;

		const [lineBefore] = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, issuedBefore.value.invoice.id));
		const [lineAfter] = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, issuedAfter.value.invoice.id));
		expect(lineBefore.vatRateBp).toBe(2100);
		expect(lineBefore.vatCents).toBe(866);
		expect(lineAfter.vatRateBp).toBe(1900);
		expect(lineAfter.vatCents).toBe(797); // 4990·1900/11900 = 796.7 → 797
	});

	it('a Bucharest-midnight order takes the rate of the Bucharest day, not the UTC day', async () => {
		await setSettings({ 'invoice.vatStandardRates': '2025-08-01 21\n2026-07-01 19' });
		// 21:30 UTC on June 30 is already July 1 in Bucharest (EEST).
		const order = await insertPaidOrder({ createdAt: new Date('2026-06-30T21:30:00Z') });
		const issued = await ensureInvoicesForOrder({ db }, order.id, 'rate-tz-test');
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		const [line] = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, issued.value.invoice.id));
		expect(line.vatRateBp).toBe(1900);
	});

	it('an unparseable rate schedule fails issuance as settings-incomplete, naming the key', async () => {
		await setSettings({ 'invoice.vatStandardRates': '2025-08-01 22' });
		const order = await insertPaidOrder({});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'bad-schedule-test');
		expect(!result.ok && result.error).toBe('settings-incomplete');
		expect(!result.ok && result.detail).toContain('invoice.vatStandardRates');
		expect(await invoicesForOrder(order.id)).toHaveLength(0);
	});

	it('a partial storno of a multi-rate invoice splits the refund across the rates pro rata', async () => {
		const order = await insertPaidOrder({
			items: [
				{ name: 'Pernă memory foam', qty: 1, priceCents: 4990 },
				{ name: 'Ceai de seară', qty: 2, priceCents: 1150, vatRateBp: 1100 }
			],
			refundedCents: 1500
		});
		expect((await ensureInvoicesForOrder({ db }, order.id, 'split-test')).ok).toBe(true);
		const storno = await issuePartialStornoForOrder({ db }, order.id, 'admin@example.ro');
		expect(storno.ok).toBe(true);
		if (!storno.ok) return;

		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, storno.value.invoice.id))
			.orderBy(asc(invoiceLines.position));
		// 1500 split 4990:2300 → 1027 @ 21 % (VAT 178) and 473 @ 11 % (VAT 47).
		expect(lines.map((line) => [line.vatRateBp, line.grossCents, line.vatCents])).toEqual([
			[2100, -1027, -178],
			[1100, -473, -47]
		]);
		expect(storno.value.invoice.grossTotalCents).toBe(-1500);
		expect(storno.value.invoice.vatTotalCents).toBe(-225);
		expect(storno.value.invoice.netTotalCents).toBe(-1275);
		const model = (await loadInvoiceModel({ db }, storno.value.invoice.id))!;
		expect(validateEFacturaXml(renderEFacturaXml(model), model)).toEqual([]);
	});
});

describe('issuer CUI (FIX-12): display form and the prefix/registration rule', () => {
	it('snapshots the CUI in display form: uppercase, RO prefix exactly when VAT-registered', async () => {
		await setSettings({ 'company.cui': 'ro12345676', 'company.vatRegistered': true });
		const registered = await ensureInvoicesForOrder(
			{ db },
			(await insertPaidOrder({})).id,
			'cui-test'
		);
		expect(registered.ok && registered.value.invoice.issuerCui).toBe('RO12345676');
	});

	it('a RO-prefixed CUI on a VAT-unregistered issuer fails issuance, naming company.cui', async () => {
		await setSettings({ 'company.cui': 'RO12345676', 'company.vatRegistered': false });
		const order = await insertPaidOrder({});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'cui-mismatch-test');
		expect(!result.ok && result.error).toBe('settings-incomplete');
		expect(!result.ok && result.detail).toContain('company.cui');
		expect(await invoicesForOrder(order.id)).toHaveLength(0);
	});

	it('a bare CUI on a VAT-registered issuer is the same mismatch', async () => {
		await setSettings({ 'company.cui': '12345676', 'company.vatRegistered': true });
		const order = await insertPaidOrder({});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'cui-mismatch-test');
		expect(!result.ok && result.error).toBe('settings-incomplete');
		expect(!result.ok && result.detail).toContain('company.cui');
	});
});

describe('address model, share capital and payment references (FIX-12)', () => {
	it('snapshots the structured issuer address + capital from settings and the buyer address from Stripe, county mapped to its ISO code', async () => {
		const order = await insertPaidOrder({
			shippingAddress: {
				name: 'Ana Pop',
				line1: 'Str. Înțelepciunii 3',
				line2: 'ap. 7',
				city: 'Cluj-Napoca',
				state: 'Județul Cluj',
				postalCode: '400001',
				country: 'RO'
			},
			customerName: 'Ana-Maria Popescu',
			paymentMethod: 'card',
			paymentIntent: 'pi_address_test'
		});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'address-test');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.invoice).toMatchObject({
			issuerStreet: 'Str. Somnului 10',
			issuerCity: 'Sector 3',
			issuerCounty: 'RO-B',
			issuerPostalCode: '030167',
			issuerCountry: 'RO',
			issuerCapital: '200 lei',
			issuerAddress: 'Str. Somnului 10\n030167 Sector 3\nBucurești',
			// B2C: the buyer is the PAYER (customer_details.name), not the parcel recipient.
			buyerName: 'Ana-Maria Popescu',
			buyerStreet: 'Str. Înțelepciunii 3, ap. 7',
			buyerCity: 'Cluj-Napoca',
			buyerCounty: 'RO-CJ',
			buyerPostalCode: '400001',
			buyerCountry: 'RO',
			buyerAddress: 'Str. Înțelepciunii 3, ap. 7\n400001 Cluj-Napoca\nCluj',
			orderReference: order.id,
			paymentReference: 'pi_address_test',
			paymentMethod: 'card',
			vatExemptionReason: ''
		});
		// Paid at order time (the webhook issues in the payment's own transaction).
		expect(result.value.invoice.paidAt?.getTime()).toBe(order.createdAt.getTime());
		const model = (await loadInvoiceModel({ db }, result.value.invoice.id))!;
		expect(validateEFacturaXml(renderEFacturaXml(model), model)).toEqual([]);
	});

	it('falls back to the parcel recipient, then the email, when Stripe sent no customer name', async () => {
		const noName = await insertPaidOrder({ customerName: '' });
		const first = await ensureInvoicesForOrder({ db }, noName.id, 'name-test');
		expect(first.ok && first.value.invoice.buyerName).toBe('Ana Pop');
		const nothing = await insertPaidOrder({ customerName: '', shippingAddress: {} });
		const second = await ensureInvoicesForOrder({ db }, nothing.id, 'name-test');
		expect(second.ok && second.value.invoice.buyerName).toBe(nothing.email);
	});

	it('a B2B buyer uses the company address (not the parcel address) and the company name', async () => {
		const order = await insertPaidOrder({
			customerName: 'Ana Pop',
			billingCompany: {
				name: 'Client SRL',
				cui: 'RO999885',
				regCom: 'J40/9999/2020',
				address: { street: 'Bd. Unirii 5', city: 'Sector 4', county: 'RO-B', postalCode: '040001' }
			}
		});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'b2b-address-test');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.invoice).toMatchObject({
			buyerName: 'Client SRL',
			buyerCompanyCui: 'RO999885',
			buyerStreet: 'Bd. Unirii 5',
			buyerCity: 'Sector 4',
			buyerCounty: 'RO-B',
			buyerPostalCode: '040001',
			buyerCountry: 'RO',
			buyerAddress: 'Bd. Unirii 5\n040001 Sector 4\nBucurești'
		});
		const model = (await loadInvoiceModel({ db }, result.value.invoice.id))!;
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).toContain('<cbc:CityName>SECTOR4</cbc:CityName>');
	});

	it('a neplătitor issuer snapshots the exemption reason in its own column', async () => {
		await setSettings({
			'company.vatRegistered': false,
			'company.cui': '12345676',
			'invoice.paymentTermsNote': 'Plata s-a efectuat cu cardul.'
		});
		const result = await ensureInvoicesForOrder({ db }, (await insertPaidOrder({})).id, 'o-test');
		expect(result.ok && result.value.invoice.vatExemptionReason).toBe('Neplătitor de TVA');
		expect(result.ok && result.value.invoice.mentions).toBe(
			'Neplătitor de TVA\nPlata s-a efectuat cu cardul.'
		);
	});

	it('the structured issuer address is required for issuance, like the rest of the identification', async () => {
		await setSettings({ 'company.county': '' });
		const order = await insertPaidOrder({});
		const result = await ensureInvoicesForOrder({ db }, order.id, 'county-required-test');
		expect(!result.ok && result.error).toBe('settings-incomplete');
		expect(!result.ok && result.detail).toContain('company.county');
	});
});
