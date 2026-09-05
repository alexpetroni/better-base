import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { siteSettings } from '../settings/schema.ts';
import type { SettingJsonValue, SettingKey } from '../settings/registry.ts';
import { orderItems, orders } from '../shop/schema.ts';
import { listOrders } from '../shop/webhook.ts';
import { ensureInvoiceDocument, invoiceDocumentKey, loadInvoiceModel } from './documents.ts';
import type { EFacturaSubmitter } from './efactura-submitter.ts';
import { invoiceSubmissions, invoices } from './schema.ts';
import { ensureInvoicesForOrder } from './service.ts';
import {
	EFACTURA_DEADLINE_DAYS,
	EFACTURA_MAX_ATTEMPTS,
	EFACTURA_SKIPPED_RETRY_MS,
	submissionRetryDelayMs,
	submitPendingEFactura,
	type EFacturaDrainDeps
} from './submissions.ts';
import { ISSUER_ADDRESS_SETTINGS } from '../../../../tests/helpers/issuer-settings.ts';

// FIX-12 (audit P1 "SPV submission is mandatory but nothing tracks it"):
// every issued document gets a `pending` submission row in the SAME
// transaction as the invoice; the cron drains those rows through the
// EFacturaSubmitter seam with retry/park semantics; the customer GET renders
// and stores but never submits; and the admin work queue can list what is
// still due at ANAF with the calendar days left. Concurrency is exercised
// for real: two ticks against the same database, one claim each.

let db: Db;
let seq = 0;

const ISSUER_SETTINGS: Partial<Record<SettingKey, SettingJsonValue>> = {
	'company.legalName': 'Șosete Țesute SRL',
	'company.cui': 'RO12345676',
	'company.vatRegistered': true,
	'company.regCom': 'J40/1234/2025',
	'company.address': 'Str. Somnului 10, București',
	...ISSUER_ADDRESS_SETTINGS,
	'invoice.seriesPrefix': 'SUB',
	'invoice.nextNumber': 1,
	'invoice.issuerPlace': 'București',
	'invoice.vatStandardRates': '2025-08-01 21'
};

/** In-memory Storage double (the fiscal bucket's semantics, not MinIO). */
function memoryStorage() {
	const objects = new Map<string, Uint8Array>();
	return {
		puts: [] as string[],
		async putObject(key: string, body: Uint8Array | string) {
			this.puts.push(key);
			objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body);
		},
		async statObject(key: string) {
			const body = objects.get(key);
			return body ? { size: body.length, mime: undefined } : null;
		},
		async getObjectBytes(key: string) {
			const body = objects.get(key);
			if (!body) throw new Error(`missing object ${key}`);
			return body;
		}
	};
}

async function insertPaidOrder(input: { status?: 'paid' | 'refunded'; refundAll?: boolean } = {}) {
	const id = `sub-order-${++seq}`;
	const priceCents = 4990;
	const [order] = await db
		.insert(orders)
		.values({
			id,
			email: `client-${seq}@example.ro`,
			stripeSessionId: `cs_${id}`,
			stripePaymentIntent: `pi_${id}`,
			amountTotalCents: priceCents,
			currency: 'ron',
			status: input.status ?? 'paid',
			paymentMethod: 'card',
			shippingAddress: {
				name: 'Ana Pop',
				line1: 'Str. Exemplu 1',
				city: 'Cluj-Napoca',
				state: 'Cluj',
				postalCode: '400001',
				country: 'RO'
			},
			...(input.refundAll ? { refundedCents: priceCents } : {})
		})
		.returning();
	await db.insert(orderItems).values({
		id: `${id}-item-0`,
		orderId: id,
		name: 'Pernă memory foam',
		qty: 1,
		priceCents
	});
	return order;
}

/** Fiscal rows are append-only (triggers); TRUNCATE is the test-only reset. */
async function resetOrders(): Promise<void> {
	await db.execute(
		sql`truncate table invoice_submissions, invoice_lines, invoices, order_events, order_items, orders cascade`
	);
}

async function submissionsOf(orderId: string) {
	return db
		.select({
			id: invoiceSubmissions.id,
			kind: invoices.kind,
			status: invoiceSubmissions.status,
			attempts: invoiceSubmissions.attempts,
			submittedAt: invoiceSubmissions.submittedAt,
			anafIndex: invoiceSubmissions.anafIndex,
			error: invoiceSubmissions.error,
			nextAttemptAt: invoiceSubmissions.nextAttemptAt,
			claimedAt: invoiceSubmissions.claimedAt,
			invoiceId: invoices.id
		})
		.from(invoiceSubmissions)
		.innerJoin(invoices, eq(invoices.id, invoiceSubmissions.invoiceId))
		.where(eq(invoices.orderId, orderId))
		.orderBy(asc(invoices.number));
}

function submittingMock(delayMs = 0) {
	const seen: string[] = [];
	const submitter: EFacturaSubmitter = {
		async submit(submission) {
			if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
			seen.push(submission.invoiceId);
			return { status: 'submitted', ref: `anaf-${submission.displayNumber}` };
		}
	};
	return { submitter, seen };
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	await db
		.insert(siteSettings)
		.values(Object.entries(ISSUER_SETTINGS).map(([key, value]) => ({ key, value })))
		.onConflictDoUpdate({ target: siteSettings.key, set: { value: sql`excluded.value` } });
});

afterAll(async () => {
	await db.$client.end();
});

describe('issuance writes the submission row', () => {
	it('a paid order: one pending row for the invoice, in the issuing transaction', async () => {
		const order = await insertPaidOrder();
		const issued = await ensureInvoicesForOrder({ db }, order.id, 'test');
		expect(issued.ok).toBe(true);
		const rows = await submissionsOf(order.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: 'invoice',
			status: 'pending',
			attempts: 0,
			submittedAt: null,
			anafIndex: null,
			error: null,
			claimedAt: null
		});
	});

	it('a refunded order: the invoice AND the storno each get a pending row', async () => {
		const order = await insertPaidOrder({ status: 'refunded', refundAll: true });
		const issued = await ensureInvoicesForOrder({ db }, order.id, 'test');
		expect(issued.ok).toBe(true);
		const rows = await submissionsOf(order.id);
		expect(rows.map((row) => [row.kind, row.status])).toEqual([
			['invoice', 'pending'],
			['storno', 'pending']
		]);
	});

	it('a retry of an already-issued order writes no second row', async () => {
		const order = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		expect(await submissionsOf(order.id)).toHaveLength(1);
	});
});

describe('the customer GET never submits', () => {
	it('ensureInvoiceDocument stores the XML and leaves the row pending', async () => {
		const order = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		const storage = memoryStorage();
		const model = (await loadInvoiceModel({ db }, invoice.id))!;
		await ensureInvoiceDocument({ db, storage }, model, 'xml');
		await ensureInvoiceDocument({ db, storage }, model, 'xml');
		expect(storage.puts).toEqual([invoiceDocumentKey(invoice.id, 'xml')]);
		const [row] = await submissionsOf(order.id);
		expect(row.status).toBe('pending');
		expect(row.attempts).toBe(0);
	});
});

describe('the cron drains pending submissions', () => {
	it('renders, stores and submits; the row records the ANAF index', async () => {
		await resetOrders();
		const order = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		const storage = memoryStorage();
		const { submitter, seen } = submittingMock();
		const deps: EFacturaDrainDeps = { db, storage, efactura: submitter };

		const result = await submitPendingEFactura(deps);
		expect(result).toEqual({ claimed: 1, submitted: 1, skipped: 0, retried: 0, parked: 0 });
		expect(seen).toEqual([invoice.id]);
		// The XML the submitter received is the stored one (fiscal bucket).
		expect(storage.puts).toEqual([invoiceDocumentKey(invoice.id, 'xml')]);
		const [row] = await submissionsOf(order.id);
		expect(row.status).toBe('submitted');
		expect(row.anafIndex).toBe(`anaf-${invoice.displayNumber}`);
		expect(row.submittedAt).not.toBeNull();
		expect(row.claimedAt).toBeNull();

		// Nothing left: a second tick is a pure no-op.
		expect(await submitPendingEFactura(deps)).toEqual({
			claimed: 0,
			submitted: 0,
			skipped: 0,
			retried: 0,
			parked: 0
		});
	});

	it('a `skipped` outcome (no enrollment) keeps the row pending, counts no attempt, defers it', async () => {
		await resetOrders();
		const order = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		const now = new Date();
		const noop: EFacturaSubmitter = {
			async submit() {
				return { status: 'skipped', reason: 'anaf-not-configured' };
			}
		};
		const deps: EFacturaDrainDeps = { db, storage: memoryStorage(), efactura: noop };

		const result = await submitPendingEFactura(deps, { now });
		expect(result).toEqual({ claimed: 1, submitted: 0, skipped: 1, retried: 0, parked: 0 });
		const [row] = await submissionsOf(order.id);
		expect(row.status).toBe('pending');
		expect(row.attempts).toBe(0);
		expect(row.claimedAt).toBeNull();
		expect(row.nextAttemptAt?.getTime()).toBe(now.getTime() + EFACTURA_SKIPPED_RETRY_MS);

		// Not due again until the deferral elapses…
		expect((await submitPendingEFactura(deps, { now })).claimed).toBe(0);
		// …then it is.
		const later = new Date(now.getTime() + EFACTURA_SKIPPED_RETRY_MS);
		expect((await submitPendingEFactura(deps, { now: later })).claimed).toBe(1);
	});

	it('a throwing submitter retries with backoff and parks after EFACTURA_MAX_ATTEMPTS', async () => {
		await resetOrders();
		const order = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		const failing: EFacturaSubmitter = {
			async submit() {
				throw new Error('SPV answered 500');
			}
		};
		const deps: EFacturaDrainDeps = { db, storage: memoryStorage(), efactura: failing };

		let now = new Date();
		for (let attempt = 1; attempt < EFACTURA_MAX_ATTEMPTS; attempt += 1) {
			const result = await submitPendingEFactura(deps, { now });
			expect(result).toEqual({ claimed: 1, submitted: 0, skipped: 0, retried: 1, parked: 0 });
			const [row] = await submissionsOf(order.id);
			expect(row.status).toBe('pending');
			expect(row.attempts).toBe(attempt);
			expect(row.error).toContain('SPV answered 500');
			expect(row.claimedAt).toBeNull();
			expect(row.nextAttemptAt?.getTime()).toBe(now.getTime() + submissionRetryDelayMs(attempt));
			// Before the backoff elapses the row is not due.
			expect((await submitPendingEFactura(deps, { now })).claimed).toBe(0);
			now = new Date(now.getTime() + submissionRetryDelayMs(attempt));
		}

		const last = await submitPendingEFactura(deps, { now });
		expect(last).toEqual({ claimed: 1, submitted: 0, skipped: 0, retried: 0, parked: 1 });
		const [parked] = await submissionsOf(order.id);
		expect(parked.status).toBe('failed');
		expect(parked.attempts).toBe(EFACTURA_MAX_ATTEMPTS);
		// Parked = a human's problem now: no further automatic claims, ever.
		const farFuture = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
		expect((await submitPendingEFactura(deps, { now: farFuture })).claimed).toBe(0);
	});

	it('the backoff doubles from the base and is capped', () => {
		expect(submissionRetryDelayMs(1)).toBeGreaterThan(0);
		expect(submissionRetryDelayMs(2)).toBe(submissionRetryDelayMs(1) * 2);
		expect(submissionRetryDelayMs(3)).toBe(submissionRetryDelayMs(1) * 4);
		expect(submissionRetryDelayMs(20)).toBe(submissionRetryDelayMs(30));
	});

	it('two concurrent ticks submit every pending document exactly once', async () => {
		await resetOrders();
		const orderRows = await Promise.all(
			Array.from({ length: 6 }, () => insertPaidOrder({ status: 'refunded', refundAll: true }))
		);
		for (const order of orderRows) await ensureInvoicesForOrder({ db }, order.id, 'test');
		const expected = (await db.select({ id: invoices.id }).from(invoices)).map((row) => row.id);
		expect(expected).toHaveLength(12);

		const { submitter, seen } = submittingMock(20);
		const deps: EFacturaDrainDeps = { db, storage: memoryStorage(), efactura: submitter };
		const [a, b] = await Promise.all([
			submitPendingEFactura(deps, { batchSize: 8 }),
			submitPendingEFactura(deps, { batchSize: 8 })
		]);

		// Every document was claimed by exactly one tick and submitted once.
		expect(a.claimed + b.claimed).toBe(12);
		expect(a.submitted + b.submitted).toBe(12);
		expect([...seen].sort()).toEqual([...expected].sort());
		expect(new Set(seen).size).toBe(12);
		const rows = await db.select().from(invoiceSubmissions);
		expect(rows.every((row) => row.status === 'submitted' && row.claimedAt === null)).toBe(true);
	});
});

describe('/admin/orders "de trimis la ANAF"', () => {
	it('lists orders with an unsubmitted document and the calendar days left', async () => {
		await resetOrders();
		const due = await insertPaidOrder();
		const done = await insertPaidOrder();
		const notInvoiced = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, due.id, 'test');
		await ensureInvoicesForOrder({ db }, done.id, 'test');
		const [doneInvoice] = await db.select().from(invoices).where(eq(invoices.orderId, done.id));
		await db
			.update(invoiceSubmissions)
			.set({ status: 'submitted', submittedAt: new Date(), anafIndex: 'anaf-1' })
			.where(eq(invoiceSubmissions.invoiceId, doneInvoice.id));

		const listed = await listOrders({ db }, 'efactura-pending');
		expect(listed.map((row) => row.id)).toEqual([due.id]);
		// Issued today: the full statutory window remains.
		expect(listed[0].efacturaDaysLeft).toBe(EFACTURA_DEADLINE_DAYS);

		const all = await listOrders({ db }, 'all');
		expect(all.find((row) => row.id === done.id)?.efacturaDaysLeft).toBeNull();
		expect(all.find((row) => row.id === notInvoiced.id)?.efacturaDaysLeft).toBeNull();
	});

	it('a parked (failed) submission stays in the queue, and an old one shows negative days', async () => {
		await resetOrders();
		const order = await insertPaidOrder();
		await ensureInvoicesForOrder({ db }, order.id, 'test');
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		await db
			.update(invoiceSubmissions)
			.set({ status: 'failed', attempts: EFACTURA_MAX_ATTEMPTS, error: 'parked' })
			.where(eq(invoiceSubmissions.invoiceId, invoice.id));
		// Backdate the document a week (the record is append-only for the app;
		// the test bypasses the trigger by disabling it for this statement).
		await db.execute(sql`alter table invoices disable trigger all`);
		await db
			.update(invoices)
			.set({ issuedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000) })
			.where(eq(invoices.id, invoice.id));
		await db.execute(sql`alter table invoices enable trigger all`);

		const listed = await listOrders({ db }, 'efactura-pending');
		expect(listed.map((row) => row.id)).toEqual([order.id]);
		expect(listed[0].efacturaDaysLeft).toBe(EFACTURA_DEADLINE_DAYS - 7);
	});
});
