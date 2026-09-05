import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import { unzipSync } from 'fflate';
import { createDb, type Db } from '../../../../../lib/db/client.ts';
import { invoiceLines, invoices } from '../../../../../lib/modules/invoice/schema.ts';
import {
	invoiceStorageConfigFromEnv,
	storageConfigFromEnv
} from '../../../../../lib/modules/media/env.ts';
import { createStorage } from '../../../../../lib/modules/media/storage.ts';
import { createSettingsLoader } from '../../../../../lib/modules/settings/service.ts';

// The accountant's monthly zip, from the real route module: month filtering,
// the CSV index (RO semicolon/comma-decimal shape), both document formats
// per invoice, and the admin-only guard.

const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
type Route = typeof import('./+server.ts');
let get: Route['GET'];

const ADMIN = {
	id: 'exp-admin',
	email: 'exp-admin@example.com',
	name: 'A',
	role: 'admin' as const
};
const EDITOR = {
	id: 'exp-editor',
	email: 'exp-ed@example.com',
	name: 'E',
	role: 'editor' as const
};

function requestEvent(month: string | null, user: typeof ADMIN | typeof EDITOR | null) {
	const url = new URL(
		`http://localhost/admin/orders/export${month === null ? '' : `?month=${month}`}`
	);
	return {
		url,
		locals: { user, settings: createSettingsLoader(() => db) }
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

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../../../drizzle')
	});
	await createStorage(storageConfigFromEnv(process.env)).ensureBucket();
	await createStorage(invoiceStorageConfigFromEnv(process.env)).ensureBucket();

	const base = {
		series: 'EXP',
		currency: 'ron',
		issuerName: 'Șosete Țesute SRL',
		issuerCui: 'RO12345676',
		issuerVatRegistered: true,
		issuerRegCom: 'J40/1234/2025',
		issuerAddress: 'Str. Somnului 10, București',
		issuerPlace: 'București',
		buyerAddress: 'Str. Viselor 1\nBucurești',
		buyerEmail: 'ana@example.ro',
		netTotalCents: 4124,
		vatTotalCents: 866,
		grossTotalCents: 4990
	};
	// Two documents inside 2026-08 (invoice + its storno), one in July.
	await db.insert(invoices).values([
		{
			...base,
			id: 'exp-aug-1',
			kind: 'invoice',
			number: 1,
			displayNumber: 'EXP-0001',
			issuedAt: new Date('2026-08-03T10:00:00Z'),
			dueAt: new Date('2026-08-03T10:00:00Z'),
			buyerName: 'Ana Pop'
		},
		{
			...base,
			id: 'exp-aug-2',
			kind: 'storno',
			number: 2,
			displayNumber: 'EXP-0002',
			stornoOfInvoiceId: 'exp-aug-1',
			issuedAt: new Date('2026-08-05T10:00:00Z'),
			dueAt: new Date('2026-08-05T10:00:00Z'),
			buyerName: 'Ana Pop',
			netTotalCents: -4124,
			vatTotalCents: -866,
			grossTotalCents: -4990
		},
		{
			...base,
			id: 'exp-jul-1',
			kind: 'invoice',
			number: 3,
			displayNumber: 'EXP-0003',
			issuedAt: new Date('2026-07-10T10:00:00Z'),
			dueAt: new Date('2026-07-10T10:00:00Z'),
			buyerName: 'Bogdan Rus'
		},
		// FIX-12 CSV hygiene fixtures. A formula-shaped buyer name and company
		// (customer-entered), a display number that starts like a formula, an
		// 11% (reduced-rate) document alongside the 21% ones, and two documents
		// at the month boundary: 2026-08-31T21:30Z is 00:30 on 1 September in
		// Bucharest (NOT August); 2026-07-31T21:30Z is 00:30 on 1 August (IS
		// August). The SQL window must use the Romanian calendar.
		{
			...base,
			id: 'exp-aug-hostile',
			kind: 'invoice',
			number: 4,
			displayNumber: '=EXP-0004',
			issuedAt: new Date('2026-08-07T10:00:00Z'),
			dueAt: new Date('2026-08-07T10:00:00Z'),
			buyerName: '=HYPERLINK("https://evil.example";"Ana")',
			buyerCompanyName: '+SUM(1;2) SRL',
			buyerCompanyCui: 'RO999885',
			netTotalCents: 2000,
			vatTotalCents: 220,
			grossTotalCents: 2220
		},
		{
			...base,
			id: 'exp-aug-boundary-in',
			kind: 'invoice',
			number: 5,
			displayNumber: 'EXP-0005',
			issuedAt: new Date('2026-07-31T21:30:00Z'),
			dueAt: new Date('2026-07-31T21:30:00Z'),
			buyerName: 'Carmen Ionescu'
		},
		{
			...base,
			id: 'exp-sep-boundary-out',
			kind: 'invoice',
			number: 6,
			displayNumber: 'EXP-0006',
			issuedAt: new Date('2026-08-31T21:30:00Z'),
			dueAt: new Date('2026-08-31T21:30:00Z'),
			buyerName: 'Dan Marin'
		}
	]);
	await db.insert(invoiceLines).values(
		[
			['exp-aug-1', 1],
			['exp-aug-2', -1],
			['exp-jul-1', 1],
			['exp-aug-boundary-in', 1],
			['exp-sep-boundary-out', 1]
		].map(([invoiceId, sign], i) => ({
			id: `exp-line-${i}`,
			invoiceId: invoiceId as string,
			position: 1,
			description: 'Pernă cu spumă cu memorie',
			qty: sign as number,
			unitPriceCents: 4990,
			vatRateBp: 2100,
			netCents: 4124 * (sign as number),
			vatCents: 866 * (sign as number),
			grossCents: 4990 * (sign as number)
		}))
	);
	// The reduced-rate document: 2220 gross at 11% → 2000 net + 220 VAT.
	await db.insert(invoiceLines).values({
		id: 'exp-line-hostile',
		invoiceId: 'exp-aug-hostile',
		position: 1,
		description: 'Ceai de seară',
		qty: 1,
		unitPriceCents: 2220,
		vatRateBp: 1100,
		netCents: 2000,
		vatCents: 220,
		grossCents: 2220
	});

	get = (await import('./+server.ts')).GET;
});

afterAll(async () => {
	await db.$client.end();
});

describe('GET /admin/orders/export', () => {
	it("zips the month's documents with the accountant CSV", async () => {
		const response = await get(requestEvent('2026-08', ADMIN));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/zip');
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="facturi-2026-08.zip"'
		);

		const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
		expect(Object.keys(entries).sort()).toEqual([
			'Factura--EXP-0004.pdf',
			'Factura--EXP-0004.xml',
			'Factura-EXP-0001.pdf',
			'Factura-EXP-0001.xml',
			'Factura-EXP-0005.pdf',
			'Factura-EXP-0005.xml',
			'Storno-EXP-0002.pdf',
			'Storno-EXP-0002.xml',
			'facturi.csv'
		]);
		expect(new TextDecoder().decode(entries['Factura-EXP-0001.pdf'].slice(0, 5))).toBe('%PDF-');

		const raw = new TextDecoder().decode(entries['facturi.csv']);
		// UTF-8 BOM: without it a ro-RO Excel reads "Pernă" as mojibake.
		expect(raw.startsWith('\uFEFF')).toBe(true);
		const csv = raw.slice(1);
		const lines = csv.trim().split('\n');
		// Per-rate base/VAT columns for every rate present in the month, highest first.
		expect(lines[0]).toBe(
			'numar;tip;data;cumparator;cui_cumparator;valoare_fara_tva;tva;total;moneda;storneaza;baza_21;tva_21;baza_11;tva_11'
		);
		expect(lines[1]).toBe('EXP-0001;factura;2026-08-03;Ana Pop;;41,24;8,66;49,90;RON;;41,24;8,66;0,00;0,00');
		expect(lines[2]).toBe(
			'EXP-0002;storno;2026-08-05;Ana Pop;;-41,24;-8,66;-49,90;RON;EXP-0001;-41,24;-8,66;0,00;0,00'
		);
		// Formula injection: number, buyer and company are neutralised, not executed.
		expect(lines[3]).toBe(
			`'=EXP-0004;factura;2026-08-07;"'+SUM(1;2) SRL";RO999885;20,00;2,20;22,20;RON;;0,00;0,00;20,00;2,20`
		);
		// The Bucharest calendar decides the month: 00:30 on 1 Aug is in, 00:30 on 1 Sep is out.
		expect(lines[4]).toBe('EXP-0005;factura;2026-08-01;Carmen Ionescu;;41,24;8,66;49,90;RON;;41,24;8,66;0,00;0,00');
		expect(lines).toHaveLength(5);
		expect(csv).not.toContain('EXP-0006');
		// July's document stays out of the August archive.
		expect(csv).not.toContain('EXP-0003');
	});

	it('the September archive holds the boundary document August must not', async () => {
		const response = await get(requestEvent('2026-09', ADMIN));
		const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
		const csv = new TextDecoder().decode(entries['facturi.csv']).slice(1);
		expect(csv).toContain('EXP-0006;factura;2026-09-01;Dan Marin');
		expect(csv).not.toContain('EXP-0005');
	});

	it('is admin-only and validates the month', async () => {
		await expect(statusOf(get(requestEvent('2026-08', EDITOR)))).resolves.toBe(403);
		// Anonymous is 401 (unauthenticated), not 403 — requireAdmin semantics.
		await expect(statusOf(get(requestEvent('2026-08', null)))).resolves.toBe(401);
		await expect(statusOf(get(requestEvent('2026-13', ADMIN)))).resolves.toBe(400);
		await expect(statusOf(get(requestEvent(null, ADMIN)))).resolves.toBe(400);
	});
});
