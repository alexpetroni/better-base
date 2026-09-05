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
		}
	]);
	await db.insert(invoiceLines).values(
		[
			['exp-aug-1', 1],
			['exp-aug-2', -1],
			['exp-jul-1', 1]
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
			'Factura-EXP-0001.pdf',
			'Factura-EXP-0001.xml',
			'Storno-EXP-0002.pdf',
			'Storno-EXP-0002.xml',
			'facturi.csv'
		]);
		expect(new TextDecoder().decode(entries['Factura-EXP-0001.pdf'].slice(0, 5))).toBe('%PDF-');

		const csv = new TextDecoder().decode(entries['facturi.csv']);
		const lines = csv.trim().split('\n');
		expect(lines[0]).toBe(
			'numar;tip;data;cumparator;cui_cumparator;valoare_fara_tva;tva;total;moneda;storneaza'
		);
		expect(lines[1]).toBe('EXP-0001;factura;2026-08-03;Ana Pop;;41,24;8,66;49,90;RON;');
		expect(lines[2]).toBe('EXP-0002;storno;2026-08-05;Ana Pop;;-41,24;-8,66;-49,90;RON;EXP-0001');
		// July's document stays out of the August archive.
		expect(csv).not.toContain('EXP-0003');
	});

	it('is admin-only and validates the month', async () => {
		await expect(statusOf(get(requestEvent('2026-08', EDITOR)))).resolves.toBe(403);
		// Anonymous is 401 (unauthenticated), not 403 — requireAdmin semantics.
		await expect(statusOf(get(requestEvent('2026-08', null)))).resolves.toBe(401);
		await expect(statusOf(get(requestEvent('2026-13', ADMIN)))).resolves.toBe(400);
		await expect(statusOf(get(requestEvent(null, ADMIN)))).resolves.toBe(400);
	});
});
