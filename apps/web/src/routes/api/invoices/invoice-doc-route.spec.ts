import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { signInvoiceDocToken, type InvoiceDocFormat } from '../../../lib/modules/invoice/access.ts';
import { invoiceLines, invoices } from '../../../lib/modules/invoice/schema.ts';
import { storageConfigFromEnv } from '../../../lib/modules/media/env.ts';
import { createStorage } from '../../../lib/modules/media/storage.ts';
import { createSettingsLoader } from '../../../lib/modules/settings/service.ts';
import { orders } from '../../../lib/modules/shop/schema.ts';
import { tokenSecretFrom } from '../../../lib/server/secrets.ts';
import { validateEFacturaXml } from '../../../lib/modules/invoice/efactura-validate.ts';
import { loadInvoiceModel } from '../../../lib/modules/invoice/documents.ts';

// The classic leak, tested on the REAL route module against the real MinIO
// bucket: an invoice document must be reachable by its owner's fresh signed
// token and by an admin session — and by NOTHING else. Anonymous, foreign
// (other-invoice) tokens, expired tokens, tampered tokens and non-admin
// staff all bounce with 403; unknown documents 404.

const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
let secret: string;
type Route = typeof import('./[id]/[format]/+server.ts');
let get: Route['GET'];

const ADMIN = {
	id: 'doc-admin',
	email: 'doc-admin@example.com',
	name: 'A',
	role: 'admin' as const
};
const EDITOR = {
	id: 'doc-editor',
	email: 'doc-editor@example.com',
	name: 'E',
	role: 'editor' as const
};

function requestEvent(
	invoiceId: string,
	format: string,
	opts: { user?: typeof ADMIN | typeof EDITOR | null; token?: string } = {}
) {
	const url = new URL(
		`http://localhost/api/invoices/${invoiceId}/${format}${opts.token ? `?t=${opts.token}` : ''}`
	);
	return {
		params: { id: invoiceId, format },
		url,
		locals: { user: opts.user ?? null, settings: createSettingsLoader(() => db) }
	} as unknown as Parameters<Route['GET']>[0];
}

async function statusOf(promise: Response | Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

const INVOICE_ID = 'route-inv-1';
const OTHER_INVOICE_ID = 'route-inv-2';

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	secret = tokenSecretFrom(process.env);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });

	// A fresh compose stack has no bucket yet (same bootstrap as storage:init).
	await createStorage(storageConfigFromEnv(process.env)).ensureBucket();

	await db.insert(orders).values(
		['route-order-1', 'route-order-2'].map((id, i) => ({
			id,
			email: `client${i}@example.ro`,
			stripeSessionId: `cs_${id}`,
			amountTotalCents: 4990,
			currency: 'ron',
			status: 'paid' as const
		}))
	);
	const base = {
		kind: 'invoice' as const,
		series: 'RTE',
		issuedAt: new Date('2026-08-07T10:00:00Z'),
		dueAt: new Date('2026-08-07T10:00:00Z'),
		currency: 'ron',
		issuerName: 'Șosete Țesute SRL',
		issuerCui: 'RO12345676',
		issuerVatRegistered: true,
		issuerRegCom: 'J40/1234/2025',
		issuerAddress: 'Str. Somnului 10, București',
		issuerPlace: 'București',
		buyerAddress: 'Str. Viselor 1\nBucurești',
		netTotalCents: 4124,
		vatTotalCents: 866,
		grossTotalCents: 4990
	};
	await db.insert(invoices).values([
		{
			...base,
			id: INVOICE_ID,
			number: 1,
			displayNumber: 'RTE-0001',
			orderId: 'route-order-1',
			buyerName: 'Ana Pop',
			buyerEmail: 'client0@example.ro'
		},
		{
			...base,
			id: OTHER_INVOICE_ID,
			number: 2,
			displayNumber: 'RTE-0002',
			orderId: 'route-order-2',
			buyerName: 'Bogdan Rus',
			buyerEmail: 'client1@example.ro'
		}
	]);
	await db.insert(invoiceLines).values(
		[INVOICE_ID, OTHER_INVOICE_ID].map((invoiceId, i) => ({
			id: `route-line-${i}`,
			invoiceId,
			position: 1,
			description: 'Pernă cu spumă cu memorie',
			qty: 1,
			unitPriceCents: 4990,
			vatRateBp: 2100,
			netCents: 4124,
			vatCents: 866,
			grossCents: 4990
		}))
	);

	get = (await import('./[id]/[format]/+server.ts')).GET;
});

afterAll(async () => {
	await db.$client.end();
});

function freshToken(invoiceId: string, format: InvoiceDocFormat): string {
	return signInvoiceDocToken(secret, invoiceId, format, new Date());
}

describe('GET /api/invoices/[id]/[format]', () => {
	it('serves the owner a PDF for a fresh signed token', async () => {
		const response = await get(
			requestEvent(INVOICE_ID, 'pdf', { token: freshToken(INVOICE_ID, 'pdf') })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="Factura-RTE-0001.pdf"'
		);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
	});

	it('serves the XML variant, and it validates against the stored record', async () => {
		const response = await get(
			requestEvent(INVOICE_ID, 'xml', { token: freshToken(INVOICE_ID, 'xml') })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/xml');
		const xml = await response.text();
		const model = await loadInvoiceModel({ db }, INVOICE_ID);
		expect(validateEFacturaXml(xml, model!)).toEqual([]);
	});

	it('refuses anonymous requests without a token', async () => {
		await expect(statusOf(get(requestEvent(INVOICE_ID, 'pdf')))).resolves.toBe(403);
	});

	it("refuses another invoice's token (cross-customer access)", async () => {
		await expect(
			statusOf(get(requestEvent(INVOICE_ID, 'pdf', { token: freshToken(OTHER_INVOICE_ID, 'pdf') })))
		).resolves.toBe(403);
	});

	it('refuses a token for the other format', async () => {
		await expect(
			statusOf(get(requestEvent(INVOICE_ID, 'xml', { token: freshToken(INVOICE_ID, 'pdf') })))
		).resolves.toBe(403);
	});

	it('refuses an expired signature', async () => {
		const past = new Date(Date.now() - 16 * 60 * 1000); // beyond the 15-min TTL
		await expect(
			statusOf(
				get(
					requestEvent(INVOICE_ID, 'pdf', {
						token: signInvoiceDocToken(secret, INVOICE_ID, 'pdf', past)
					})
				)
			)
		).resolves.toBe(403);
	});

	it('refuses tampered and malformed tokens', async () => {
		const token = freshToken(INVOICE_ID, 'pdf');
		const [exp] = token.split('.');
		await expect(
			statusOf(get(requestEvent(INVOICE_ID, 'pdf', { token: `${exp}.AAAA${token.slice(-8)}` })))
		).resolves.toBe(403);
		await expect(
			statusOf(get(requestEvent(INVOICE_ID, 'pdf', { token: 'garbage' })))
		).resolves.toBe(403);
	});

	it('lets an admin session in without a token; editors need one', async () => {
		const response = await get(requestEvent(INVOICE_ID, 'pdf', { user: ADMIN }));
		expect(response.status).toBe(200);
		await expect(statusOf(get(requestEvent(INVOICE_ID, 'pdf', { user: EDITOR })))).resolves.toBe(
			403
		);
	});

	it('404s an unknown invoice and an unknown format', async () => {
		await expect(
			statusOf(get(requestEvent('no-such-invoice', 'pdf', { user: ADMIN })))
		).resolves.toBe(404);
		await expect(statusOf(get(requestEvent(INVOICE_ID, 'exe', { user: ADMIN })))).resolves.toBe(
			404
		);
	});
});
