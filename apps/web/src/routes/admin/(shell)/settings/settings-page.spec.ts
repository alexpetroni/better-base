import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure } from '@sveltejs/kit';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { adminAudit, users } from '../../../../lib/modules/auth/schema.ts';
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
		locals: { user: STAFF, settings: createSettingsLoader(() => db), requestId: 'spec' }
	};
}

const COMPANY_FIELDS = {
	group: 'company',
	'company.legalName': 'Exemplu SRL',
	'company.cui': 'RO12345676',
	'company.vatRegistered': 'on',
	'company.regCom': 'J40/1234/2024',
	'company.address': 'Str. Exemplu 1, București',
	'company.street': 'Str. Exemplu 1',
	'company.city': 'Sector 3',
	'company.county': 'RO-B',
	'company.postalCode': '030167',
	'company.shareCapital': '200 lei',
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

	it('stores the invoice group: integer next number, the rate schedule as trimmed text', async () => {
		const result = await saveAction(
			saveEvent({
				group: 'invoice',
				'invoice.seriesPrefix': 'BSL',
				'invoice.nextNumber': '7',
				'invoice.issuerPlace': 'București',
				'invoice.vatStandardRates': ' 2017-01-01 19\n2025-08-01 21 ',
				'invoice.paymentTermsNote': ''
			})
		);
		expect(result).toEqual({ saved: true, group: 'invoice' });
		const rows = await db.select().from(siteSettings);
		const value = (key: string) => rows.find((row) => row.key === key)?.value;
		expect(value('invoice.vatStandardRates')).toBe('2017-01-01 19\n2025-08-01 21');
		expect(value('invoice.nextNumber')).toBe(7);
	});

	it('refuses a rate schedule with a zero or unlisted rate, echoing the input', async () => {
		const result = await saveAction(
			saveEvent({
				group: 'invoice',
				'invoice.seriesPrefix': 'BSL',
				'invoice.nextNumber': '7',
				'invoice.issuerPlace': 'București',
				'invoice.vatStandardRates': '2025-08-01 0',
				'invoice.paymentTermsNote': ''
			})
		);
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		const data = result.data as unknown as {
			errors: Record<string, string>;
			values: Record<string, string>;
		};
		expect(data.errors).toEqual({ 'invoice.vatStandardRates': 'invalid-vat-rate' });
		expect(data.values['invoice.vatStandardRates']).toBe('2025-08-01 0');
		expect(
			(await db.select().from(siteSettings)).find((row) => row.key === 'invoice.vatStandardRates')
		).toBeUndefined();
	});
});

// Review 2026-09-05 #6: settings saves — the invoice IBAN included — left no
// audit trail, and the IBAN had no checksum.
describe('/admin/settings audit row and IBAN validation (FIX-18)', () => {
	// admin_audit is append-only (a trigger forbids UPDATE/DELETE), so every
	// case counts the rows it added on top of what earlier cases wrote.
	const settingsSaves = () =>
		db
			.select()
			.from(adminAudit)
			.where(sql`${adminAudit.action} = 'settings-save'`)
			.orderBy(adminAudit.id);

	it('writes one settings-save row per successful save: actor, group, changed keys, IBAN old → new', async () => {
		const baseline = (await settingsSaves()).length;
		const first = await saveAction(
			saveEvent({
				...COMPANY_FIELDS,
				'company.iban': 'RO49AAAA1B31007593840000',
				'company.bank': 'Banca X'
			})
		);
		expect(first).toEqual({ saved: true, group: 'company' });
		const rows = (await settingsSaves()).slice(baseline);
		expect(rows).toHaveLength(1);
		expect(rows[0].actor).toBe(STAFF.email);
		expect(rows[0].target).toContain('company');
		expect(rows[0].target).toContain('company.legalName');
		expect(rows[0].target).toContain('company.iban');
		expect(rows[0].target).toContain('"" → "RO49AAAA1B31007593840000"');
		expect(rows[0].target).toContain('"" → "Banca X"');

		// Changing only the IBAN records that change with both values.
		const second = await saveAction(
			saveEvent({
				...COMPANY_FIELDS,
				'company.iban': 'DE89370400440532013000',
				'company.bank': 'Banca X'
			})
		);
		expect(second).toEqual({ saved: true, group: 'company' });
		const after = (await settingsSaves()).slice(baseline);
		expect(after).toHaveLength(2);
		expect(after[1].target).toContain('"RO49AAAA1B31007593840000" → "DE89370400440532013000"');
		expect(after[1].target).not.toContain('company.legalName');
	});

	it('a save that changes nothing writes no audit row', async () => {
		const baseline = (await settingsSaves()).length;
		await saveAction(saveEvent(COMPANY_FIELDS));
		expect(await settingsSaves()).toHaveLength(baseline + 1);
		expect(await saveAction(saveEvent(COMPANY_FIELDS))).toEqual({ saved: true, group: 'company' });
		expect(await settingsSaves()).toHaveLength(baseline + 1);
	});

	it('refuses an IBAN that fails mod-97 with a field error and writes NOTHING', async () => {
		const baseline = (await settingsSaves()).length;
		const result = await saveAction(
			saveEvent({ ...COMPANY_FIELDS, 'company.iban': 'RO49AAAA1B31007593480000' })
		);
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		const data = result.data as unknown as { errors: Record<string, string> };
		expect(data.errors).toEqual({ 'company.iban': 'invalid-iban' });
		expect(await db.select().from(siteSettings)).toHaveLength(0);
		expect(await settingsSaves()).toHaveLength(baseline);
	});

	it('stores the IBAN normalised (upper case, no spaces)', async () => {
		await saveAction(
			saveEvent({ ...COMPANY_FIELDS, 'company.iban': 'ro49 aaaa 1b31 0075 9384 0000' })
		);
		const row = (await db.select().from(siteSettings)).find((r) => r.key === 'company.iban');
		expect(row?.value).toBe('RO49AAAA1B31007593840000');
	});
});

describe('/admin/settings auto-migrated VAT schedule warning (FIX-18)', () => {
	it('flags the schedule migration 0024 derived from a legacy rate until the group is saved', async () => {
		await db.insert(siteSettings).values({
			key: 'invoice.vatRateBp',
			value: 1900,
			updatedAt: new Date('2025-03-01T10:00:00Z'),
			updatedBy: STAFF.id
		});
		const backfill = readFileSync(
			path.resolve(import.meta.dirname, '../../../../../drizzle/0024_vat_model.sql'),
			'utf8'
		)
			.split('--> statement-breakpoint')
			.find((statement) => statement.includes('INSERT INTO "site_settings"'))!;
		await db.execute(sql.raw(backfill));

		type Data = { vatScheduleAutoMigrated: boolean };
		const before = (await load(saveEvent({}) as unknown as Parameters<typeof load>[0])) as Data;
		expect(before.vatScheduleAutoMigrated).toBe(true);

		const result = await saveAction(
			saveEvent({
				group: 'invoice',
				'invoice.seriesPrefix': 'BSL',
				'invoice.nextNumber': '7',
				'invoice.issuerPlace': 'București',
				'invoice.vatStandardRates': '2025-08-01 19',
				'invoice.paymentTermsNote': ''
			})
		);
		expect(result).toEqual({ saved: true, group: 'invoice' });
		const after = (await load(saveEvent({}) as unknown as Parameters<typeof load>[0])) as Data;
		expect(after.vatScheduleAutoMigrated).toBe(false);
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
				'invoice.vatStandardRates': '2025-08-01 21',
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
