import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Stripe from 'stripe';
import { createDb, type Db } from '../../db/client.ts';
import { createEmailSender } from '../email/service.ts';
import { emailLog } from '../email/schema.ts';
import { siteSettings } from '../settings/schema.ts';
import type { SettingJsonValue, SettingKey } from '../settings/registry.ts';
import { buildCartMetadata } from '../shop/checkout.ts';
import { orders } from '../shop/schema.ts';
import { processStripeEvent, verifyStripeEvent, type WebhookDeps } from '../shop/webhook.ts';
import type { EFacturaSubmitter } from './efactura-submitter.ts';
import { validateEFacturaXml } from './efactura-validate.ts';
import {
	ensureInvoiceDocument,
	ensureInvoiceDocuments,
	invoiceDocumentKey,
	invoicePdfAttachmentForOrder,
	loadInvoiceModel,
	type InvoiceDocumentDeps
} from './documents.ts';
import { invoices } from './schema.ts';

// Integration for the document layer: write-once storage semantics, the
// e-Factura seam firing exactly once, the confirmation email carrying the
// invoice PDF in dry-run capture, idempotent re-sends — and the serverless
// tripwire that no runtime code in the invoice path touches the filesystem.
// Storage is an in-memory fake HERE (semantics under test, not MinIO — the
// real bucket is exercised by the route spec and e2e).

const WEBHOOK_SECRET = 'whsec_documents_spec_secret';
const stripeSigner = new Stripe('sk_test_offline_signing_only');

let db: Db;

/** In-memory Storage double that counts writes. */
function memoryStorage() {
	const objects = new Map<string, Uint8Array>();
	const store = {
		puts: [] as string[],
		async putObject(key: string, body: Uint8Array | string) {
			store.puts.push(key);
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
	return store;
}

const ISSUER_SETTINGS: Partial<Record<SettingKey, SettingJsonValue>> = {
	'company.legalName': 'Șosete Țesute SRL',
	'company.cui': 'RO12345676',
	'company.vatRegistered': true,
	'company.regCom': 'J40/1234/2025',
	'company.address': 'Str. Somnului 10, București',
	'invoice.seriesPrefix': 'BSL',
	'invoice.nextNumber': 101,
	'invoice.issuerPlace': 'București',
	'invoice.vatStandardRates': '2025-08-01 21'
};

async function setIssuerSettings(): Promise<void> {
	const rows = Object.entries(ISSUER_SETTINGS).map(([key, value]) => ({ key, value }));
	await db
		.insert(siteSettings)
		.values(rows)
		.onConflictDoUpdate({ target: siteSettings.key, set: { value: sql`excluded.value` } });
}

let seq = 0;

/** A paid order created through the REAL webhook path (invoice included). */
async function orderViaWebhook(deps: WebhookDeps): Promise<string> {
	seq += 1;
	const sessionId = `cs_docs_${seq}`;
	const payload = JSON.stringify({
		id: `evt_docs_${seq}`,
		object: 'event',
		type: 'checkout.session.completed',
		data: {
			object: {
				id: sessionId,
				object: 'checkout.session',
				amount_total: 9980,
				currency: 'ron',
				payment_intent: `pi_docs_${seq}`,
				payment_status: 'paid',
				customer_details: { email: `ana${seq}@example.ro`, name: 'Ana Pop' },
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: { line1: 'Str. Viselor 1', city: 'București', country: 'RO' }
					}
				},
				metadata: {
					cart: buildCartMetadata([{ productId: 'nope', qty: 2, priceCents: 4990 }])
				}
			}
		}
	});
	const event = await verifyStripeEvent(
		payload,
		stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
		WEBHOOK_SECRET
	);
	const outcome = await processStripeEvent(deps, event);
	if (outcome.kind !== 'order-created' && outcome.kind !== 'duplicate-event') {
		throw new Error(`unexpected webhook outcome ${outcome.kind}`);
	}
	const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
	return order.id;
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
	await setIssuerSettings();
});

afterAll(async () => {
	await db.$client.end();
});

beforeEach(async () => {
	await db.execute(sql`delete from email_log`);
});

describe('write-once document storage', () => {
	it('stores each document once; re-requests read, never re-render', async () => {
		const storage = memoryStorage();
		const deps: InvoiceDocumentDeps = { db, storage };
		const orderId = await orderViaWebhook({
			db,
			email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
			siteName: 'Better Sleep'
		});
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, orderId));

		const first = await ensureInvoiceDocuments(deps, invoice.id);
		expect(first).not.toBeNull();
		expect(storage.puts).toEqual([
			invoiceDocumentKey(invoice.id, 'pdf'),
			invoiceDocumentKey(invoice.id, 'xml')
		]);

		const second = await ensureInvoiceDocuments(deps, invoice.id);
		// No new writes — and the returned bytes are the stored ones.
		expect(storage.puts).toHaveLength(2);
		expect(Buffer.from(second!.pdf).equals(Buffer.from(first!.pdf))).toBe(true);
		expect(Buffer.from(second!.xml).equals(Buffer.from(first!.xml))).toBe(true);
		expect(new TextDecoder().decode(first!.pdf.slice(0, 5))).toBe('%PDF-');

		// The stored XML is a valid CIUS-RO document agreeing with the record.
		const model = await loadInvoiceModel({ db }, invoice.id);
		expect(validateEFacturaXml(new TextDecoder().decode(first!.xml), model!)).toEqual([]);
	});

	it('runs the e-Factura seam exactly once, on the first XML store', async () => {
		const storage = memoryStorage();
		const submissions: string[] = [];
		const submitter: EFacturaSubmitter = {
			async submit(submission) {
				submissions.push(submission.displayNumber);
				return { status: 'skipped', reason: 'test' };
			}
		};
		const deps: InvoiceDocumentDeps = { db, storage, efactura: submitter };
		const orderId = await orderViaWebhook({
			db,
			email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
			siteName: 'Better Sleep'
		});
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, orderId));

		await ensureInvoiceDocument(deps, (await loadInvoiceModel({ db }, invoice.id))!, 'xml');
		await ensureInvoiceDocument(deps, (await loadInvoiceModel({ db }, invoice.id))!, 'xml');
		expect(submissions).toEqual([invoice.displayNumber]);
	});
});

describe('confirmation email with the invoice attached', () => {
	it('dry-run capture records the PDF attachment, number and durable link', async () => {
		const storage = memoryStorage();
		const deps: WebhookDeps = {
			db,
			email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
			siteName: 'Better Sleep',
			invoiceAttachment: (orderId) => invoicePdfAttachmentForOrder({ db, storage }, orderId),
			publicBaseUrl: 'https://better-sleep.ro'
		};
		const orderId = await orderViaWebhook(deps);
		const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, orderId));

		const [log] = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `order-confirmation:${orderId}`));
		expect(log.status).toBe('dryrun');
		expect(log.attachments).toEqual([
			{
				filename: `Factura-${invoice.displayNumber}.pdf`,
				contentType: 'application/pdf',
				size: expect.any(Number)
			}
		]);
		expect((log.attachments![0].size as number) > 1000).toBe(true);
		expect(log.data.invoiceNumber).toBe(invoice.displayNumber);
		expect(log.data.orderUrl).toBe(
			`https://better-sleep.ro/cos/succes?session_id=${order.stripeSessionId}`
		);
	});

	it('a broken document layer never blocks the confirmation email', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const deps: WebhookDeps = {
				db,
				email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
				siteName: 'Better Sleep',
				invoiceAttachment: async () => {
					throw new Error('S3 down');
				},
				publicBaseUrl: 'https://better-sleep.ro'
			};
			const orderId = await orderViaWebhook(deps);
			const [log] = await db
				.select()
				.from(emailLog)
				.where(eq(emailLog.idempotencyKey, `order-confirmation:${orderId}`));
			expect(log.status).toBe('dryrun');
			expect(log.attachments).toBeNull();
			expect(consoleError).toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});

	it('re-send is idempotent under the same key', async () => {
		const storage = memoryStorage();
		const sender = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
		const orderId = await orderViaWebhook({ db, email: sender, siteName: 'Better Sleep' });
		const info = await invoicePdfAttachmentForOrder({ db, storage }, orderId);
		expect(info).not.toBeNull();

		const key = `invoice-email:${info!.invoiceId}:nonce-1`;
		const send = () =>
			sender.send({
				to: 'ana@example.ro',
				template: 'invoice-email',
				data: { siteName: 'Better Sleep', invoiceNumber: info!.displayNumber },
				attachments: [info!.attachment],
				idempotencyKey: key
			});
		expect((await send()).status).toBe('dryrun');
		expect((await send()).status).toBe('skipped');
		const rows = await db.select().from(emailLog).where(eq(emailLog.idempotencyKey, key));
		expect(rows).toHaveLength(1);
	});

	it('returns null (no attachment) while the order has no invoice', async () => {
		const storage = memoryStorage();
		await db.insert(orders).values({
			id: 'docs-no-invoice',
			email: 'x@example.ro',
			stripeSessionId: 'cs_docs_no_invoice',
			amountTotalCents: 1000,
			currency: 'ron',
			status: 'paid'
		});
		await expect(
			invoicePdfAttachmentForOrder({ db, storage }, 'docs-no-invoice')
		).resolves.toBeNull();
	});
});

describe('serverless constraint', () => {
	it('no runtime filesystem access anywhere in the document path', () => {
		const root = path.resolve(import.meta.dirname, '../../..');
		const runtimeDirs = [
			'lib/modules/invoice',
			'lib/modules/email',
			'lib/modules/shop',
			'routes/api/invoices',
			'routes/api/shipments',
			'routes/api/stripe',
			'routes/api/cron',
			'routes/admin/(shell)/orders'
		];
		const offenders: string[] = [];
		for (const dir of runtimeDirs) {
			for (const entry of readdirSync(path.join(root, dir), {
				recursive: true,
				withFileTypes: true
			})) {
				if (!entry.isFile()) continue;
				const name = entry.name;
				if (!/\.(ts|svelte)$/.test(name) || /\.spec\.ts$/.test(name)) continue;
				const filePath = path.join(entry.parentPath, name);
				const source = readFileSync(filePath, 'utf8');
				if (/node:fs|from ['"]fs['"]|require\(['"]fs/.test(source)) {
					offenders.push(path.relative(root, filePath));
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
