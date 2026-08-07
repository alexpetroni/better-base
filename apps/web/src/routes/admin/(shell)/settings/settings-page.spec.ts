import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure } from '@sveltejs/kit';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { users } from '../../../../lib/modules/auth/schema.ts';
import { siteSettings } from '../../../../lib/modules/settings/schema.ts';
import { createSettingsLoader } from '../../../../lib/modules/settings/service.ts';

// Route-level integration: the REAL /admin/settings load + save action and the
// REAL (public) layout load, invoked the way SvelteKit invokes them. `$env`
// values are a build-time snapshot under vitest, so the app db is redirected
// to TEST_DATABASE_URL by mocking `$lib/db`.
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;

const STAFF = {
	id: 'settings-page-staff-1',
	email: 'settings-page-admin@example.com',
	name: 'Settings Admin',
	role: 'admin' as const
};

type SettingsPage = typeof import('./+page.server.ts');
let load: SettingsPage['load'];
let saveAction: (event: { request: Request; locals: App.Locals }) => Promise<unknown>;
let publicLayoutLoad: (event: unknown) => Promise<Record<string, unknown>>;

function saveEvent(fields: Record<string, string>): { request: Request; locals: App.Locals } {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/admin/settings?/save', { method: 'POST', body }),
		locals: { user: STAFF, settings: createSettingsLoader(() => db) }
	};
}

const COMPANY_FIELDS = {
	group: 'company',
	'company.legalName': 'Exemplu SRL',
	'company.cui': 'RO12345678',
	'company.vatRegistered': 'on',
	'company.regCom': 'J40/1234/2024',
	'company.address': 'Str. Exemplu 1, București',
	'company.contactEmail': 'contact@exemplu.ro',
	'company.contactPhone': '+40 700 000 000',
	'company.iban': '',
	'company.bank': ''
};

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			'TEST_DATABASE_URL is not set — start the database with `docker compose up -d db` and configure .env'
		);
	}
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../../drizzle')
	});
	await db.insert(users).values({ id: STAFF.id, name: STAFF.name, email: STAFF.email });

	const page = await import('./+page.server.ts');
	load = page.load;
	saveAction = page.actions.save as unknown as typeof saveAction;
	const publicLayout = await import('../../../(public)/+layout.server.ts');
	publicLayoutLoad = publicLayout.load as unknown as typeof publicLayoutLoad;
});

afterAll(async () => {
	await (appDbHolder.db as Db | undefined)?.$client.end();
	await db?.$client.end();
});

beforeEach(async () => {
	await db.delete(siteSettings);
});

describe('/admin/settings save action', () => {
	it('persists a valid group with audit fields; a re-load returns the new values', async () => {
		const result = await saveAction(saveEvent(COMPANY_FIELDS));
		expect(result).toEqual({ saved: true, group: 'company' });

		const rows = await db.select().from(siteSettings);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.updatedBy).toBe(STAFF.id);

		const data = (await load(saveEvent({}) as unknown as Parameters<typeof load>[0])) as {
			groups: Array<{ id: string; fields: Array<{ key: string; value: string | boolean }> }>;
			audit: { byEmail: string | null } | null;
		};
		const company = data.groups.find((group) => group.id === 'company')!;
		const field = (key: string) => company.fields.find((f) => f.key === key)!.value;
		expect(field('company.legalName')).toBe('Exemplu SRL');
		expect(field('company.vatRegistered')).toBe(true);
		expect(data.audit?.byEmail).toBe(STAFF.email);
	});

	it('re-renders invalid input with per-field errors and writes NOTHING', async () => {
		const result = await saveAction(
			saveEvent({
				...COMPANY_FIELDS,
				'company.cui': 'not-a-cui',
				'company.contactEmail': 'not-an-email'
			})
		);
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		const data = result.data as unknown as {
			group: string;
			errors: Record<string, string>;
			values: Record<string, string | boolean>;
		};
		expect(data.group).toBe('company');
		expect(data.errors).toEqual({
			'company.cui': 'invalid-cui',
			'company.contactEmail': 'invalid-email'
		});
		// The typed input is echoed back, and nothing reached the table.
		expect(data.values['company.legalName']).toBe('Exemplu SRL');
		expect(await db.select().from(siteSettings)).toHaveLength(0);
	});

	it('converts percent/lei input to integer bp/bani on save', async () => {
		const result = await saveAction(
			saveEvent({
				group: 'invoice',
				'invoice.seriesPrefix': 'BSL',
				'invoice.nextNumber': '7',
				'invoice.issuerPlace': 'București',
				'invoice.vatRateBp': '19,5',
				'invoice.paymentTermsNote': ''
			})
		);
		expect(result).toEqual({ saved: true, group: 'invoice' });
		const rows = await db.select().from(siteSettings);
		const value = (key: string) => rows.find((row) => row.key === key)?.value;
		expect(value('invoice.vatRateBp')).toBe(1950);
		expect(value('invoice.nextNumber')).toBe(7);
	});
});

describe('client exposure through the public layout', () => {
	it('serializes ONLY client-safe settings into the page payload', async () => {
		// Server-only values an operator saved must never reach PageData/HTML.
		await saveAction(saveEvent({ ...COMPANY_FIELDS, 'company.iban': 'RO49AAAA1B31007593840000' }));
		await saveAction(
			saveEvent({
				group: 'invoice',
				'invoice.seriesPrefix': 'SECRET-SERIES',
				'invoice.nextNumber': '1',
				'invoice.issuerPlace': 'București',
				'invoice.vatRateBp': '21',
				'invoice.paymentTermsNote': ''
			})
		);

		const payload = await publicLayoutLoad({
			cookies: { get: () => undefined },
			locals: { user: null, settings: createSettingsLoader(() => db) }
		});

		const serialized = JSON.stringify(payload);
		expect(serialized).toContain('Exemplu SRL');
		expect(serialized).toContain('company.legalName');
		// The whole payload — the exact data SvelteKit embeds in the rendered
		// HTML — carries neither the non-safe keys nor their values.
		expect(serialized).not.toContain('company.iban');
		expect(serialized).not.toContain('RO49AAAA1B31007593840000');
		expect(serialized).not.toContain('invoice.seriesPrefix');
		expect(serialized).not.toContain('SECRET-SERIES');
	});
});
