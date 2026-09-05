import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ISSUER_ADDRESS_SETTINGS } from '../../../../tests/helpers/issuer-settings.ts';
import { createDb, type Db } from '../../db/client.ts';
import { seedPlaceholderSettings } from '../../db/seed.ts';
import { users } from '../auth/schema.ts';
import {
	clientSafeSettings,
	isSettingKey,
	LAUNCH_REQUIRED_SETTING_KEYS,
	mergeSettings,
	parseSettingInput,
	settingsDefaults,
	validateSettingValue,
	type SettingKey,
	type SiteSettings
} from './registry.ts';
import { siteSettings } from './schema.ts';
import {
	autoMigratedVatSchedule,
	createSettingsLoader,
	loadSettings,
	loadSettingsForAdmin,
	saveSettings,
	settingsLaunchProblems
} from './service.ts';

// ---------------------------------------------------------------------------
// Registry (pure, offline)
// ---------------------------------------------------------------------------

describe('settings registry validation', () => {
	it('accepts the valid shape of each kind', () => {
		expect(validateSettingValue('company.legalName', 'Exemplu SRL')).toBeNull();
		expect(validateSettingValue('company.cui', 'RO12345676')).toBeNull();
		expect(validateSettingValue('company.cui', '12345676')).toBeNull();
		expect(validateSettingValue('company.vatRegistered', true)).toBeNull();
		expect(validateSettingValue('company.contactEmail', 'contact@exemplu.ro')).toBeNull();
		expect(validateSettingValue('legal.anpcSalUrl', 'https://anpc.ro/ce-este-sal/')).toBeNull();
		expect(validateSettingValue('company.county', 'RO-CJ')).toBeNull();
		expect(validateSettingValue('company.postalCode', '400001')).toBeNull();
		expect(validateSettingValue('company.shareCapital', '200 lei')).toBeNull();
		expect(validateSettingValue('invoice.vatStandardRates', '2025-08-01 21')).toBeNull();
		expect(
			validateSettingValue('invoice.vatStandardRates', '2017-01-01 19\n2025-08-01 21')
		).toBeNull();
		expect(validateSettingValue('invoice.nextNumber', 1)).toBeNull();
		expect(validateSettingValue('shop.freeShippingThresholdBani', 0)).toBeNull();
		// Optional text may stay empty.
		expect(validateSettingValue('company.iban', '')).toBeNull();
	});

	it('rejects the obvious wrong ones', () => {
		// Empty CUI (launch-required text must be non-empty on save).
		expect(validateSettingValue('company.cui', '')).toBe('required');
		expect(validateSettingValue('company.cui', 'not-a-cui')).toBe('invalid-cui');
		// Shape alone is not enough: the mod-11 control digit must check out
		// (audit 2026-09-03 P1 "CUI is shape-only").
		expect(validateSettingValue('company.cui', 'RO12345678')).toBe('invalid-cui');
		expect(validateSettingValue('company.cui', '12345678')).toBe('invalid-cui');
		// Non-URL ANPC link.
		expect(validateSettingValue('legal.anpcSalUrl', 'anpc punct ro')).toBe('invalid-url');
		expect(validateSettingValue('legal.anpcSolUrl', 'ftp://example.com')).toBe('invalid-url');
		// The standard-rate schedule: a zero rate on a registered issuer would
		// emit category Z by accident, an unlisted rate is a typo, and a
		// malformed line is not a schedule at all.
		expect(validateSettingValue('invoice.vatStandardRates', '')).toBe('required');
		expect(validateSettingValue('invoice.vatStandardRates', '2025-08-01 0')).toBe(
			'invalid-vat-rate'
		);
		expect(validateSettingValue('invoice.vatStandardRates', '2025-08-01 22')).toBe(
			'invalid-vat-rate'
		);
		expect(validateSettingValue('invoice.vatStandardRates', '21')).toBe('invalid-vat-rate');
		// The county is an ISO 3166-2:RO code — CIUS-RO wants exactly that.
		expect(validateSettingValue('company.county', 'Cluj')).toBe('invalid-county');
		expect(validateSettingValue('company.county', 'CJ')).toBe('invalid-county');
		expect(validateSettingValue('company.postalCode', 'a')).toBe('invalid-value');
		expect(validateSettingValue('invoice.vatStandardRates', 2100)).toBe('invalid-value');
		// Non-integers and wrong primitive types never validate.
		expect(validateSettingValue('invoice.nextNumber', 0)).toBe('invalid-number');
		expect(validateSettingValue('company.contactEmail', 'not-an-email')).toBe('invalid-email');
		expect(validateSettingValue('company.vatRegistered', 'da')).toBe('invalid-value');
		expect(validateSettingValue('company.legalName', 42)).toBe('invalid-value');
	});

	it('parses admin input with integer math only: lei → bani', () => {
		expect(parseSettingInput('shop.freeShippingThresholdBani', '250')).toEqual({
			ok: true,
			value: 25_000
		});
		expect(parseSettingInput('shop.shippingStandardPriceBani', '19,90')).toEqual({
			ok: true,
			value: 1990
		});
		expect(parseSettingInput('invoice.nextNumber', '42')).toEqual({ ok: true, value: 42 });
		// The rate schedule is stored as the (trimmed) text the operator typed.
		expect(parseSettingInput('invoice.vatStandardRates', ' 2025-08-01 21 ')).toEqual({
			ok: true,
			value: '2025-08-01 21'
		});
		// Signs, letters and empty numerics are rejected, not guessed at.
		expect(parseSettingInput('shop.shippingStandardPriceBani', '-5')).toEqual({
			ok: false,
			code: 'invalid-number'
		});
		expect(parseSettingInput('invoice.nextNumber', 'abc')).toEqual({
			ok: false,
			code: 'invalid-number'
		});
		expect(parseSettingInput('shop.freeShippingThresholdBani', '')).toEqual({
			ok: false,
			code: 'invalid-number'
		});
	});

	it('rejects unknown keys at runtime (and by type at compile time)', async () => {
		expect(isSettingKey('company.unknown')).toBe(false);
		expect(isSettingKey('company.legalName')).toBe(true);
		// An unregistered key is a type error at compile time; the runtime guard
		// in saveSettings is what protects against forged input.
		const result = await saveSettings(
			{ db: undefined as unknown as Db },
			{ 'company.unknown': 'x' } as unknown as Record<SettingKey, string>,
			'staff-1'
		);
		expect(result).toEqual({ ok: false, error: 'unknown-key', detail: 'company.unknown' });
	});

	it('returns the declared default for a never-set key', () => {
		const settings = mergeSettings([]);
		expect(settings['invoice.vatStandardRates']).toBe('2025-08-01 21');
		expect(settings['invoice.nextNumber']).toBe(1);
		expect(settings['company.vatRegistered']).toBe(false);
		expect(settings['company.legalName']).toBe('');
		expect(settings).toEqual(settingsDefaults());
	});

	it('merges stored rows over defaults, ignoring unknown keys and wrong types', () => {
		const settings = mergeSettings([
			{ key: 'company.legalName', value: 'Exemplu SRL' },
			{ key: 'future.notYetKnown', value: 'from a newer deploy' },
			{ key: 'invoice.nextNumber', value: 'not-a-number' }
		]);
		expect(settings['company.legalName']).toBe('Exemplu SRL');
		expect(settings['invoice.nextNumber']).toBe(1);
		expect('future.notYetKnown' in settings).toBe(false);
	});

	it('exposes exactly the client-safe keys, nothing more', () => {
		const settings = settingsDefaults();
		const exposed = clientSafeSettings(settings);
		expect(Object.keys(exposed)).toContain('company.legalName');
		expect(Object.keys(exposed)).toContain('legal.anpcSalUrl');
		// Bank details and invoicing internals must never reach the client.
		expect(Object.keys(exposed)).not.toContain('company.iban');
		expect(Object.keys(exposed)).not.toContain('company.bank');
		expect(Object.keys(exposed)).not.toContain('invoice.seriesPrefix');
		expect(Object.keys(exposed)).not.toContain('invoice.nextNumber');
		expect(Object.keys(exposed)).not.toContain('invoice.vatStandardRates');
	});
});

describe('request-scoped settings loader', () => {
	function countingDb(rows: Array<{ key: string; value: unknown }>) {
		let queries = 0;
		const db = {
			select: () => {
				queries += 1;
				return { from: () => Promise.resolve(rows) };
			}
		} as unknown as Db;
		return { db, queries: () => queries };
	}

	it('costs at most ONE query per request, however many loads ask', async () => {
		const { db, queries } = countingDb([{ key: 'company.legalName', value: 'Exemplu SRL' }]);
		const settings = createSettingsLoader(() => db);
		// Concurrent loads (layout + page) share the in-flight promise…
		const [a, b] = await Promise.all([settings(), settings()]);
		// …and later sequential reads reuse the resolved one.
		const c = await settings();
		expect(a['company.legalName']).toBe('Exemplu SRL');
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(queries()).toBe(1);
	});

	it('does not leak across requests: a new loader queries again', async () => {
		const { db, queries } = countingDb([]);
		await createSettingsLoader(() => db)();
		await createSettingsLoader(() => db)();
		expect(queries()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Service + launch rule (integration, TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

let db: Db;

const STAFF = { id: 'settings-staff-1', email: 'settings-admin@example.com' };

/** Valid values for every launch-required key (used to green launch:check). */
const VALID_LAUNCH_VALUES: Partial<SiteSettings> = {
	'company.legalName': 'Exemplu SRL',
	'company.cui': 'RO12345676',
	// The RO prefix must agree with the registration flag (FIX-12).
	'company.vatRegistered': true,
	'company.regCom': 'J40/1234/2024',
	'company.address': 'Str. Exemplu 1, București',
	...ISSUER_ADDRESS_SETTINGS,
	'company.contactEmail': 'contact@exemplu.ro',
	'company.contactPhone': '+40 700 000 000',
	'legal.anpcSalUrl': 'https://anpc.ro/ce-este-sal/',
	'legal.anpcSolUrl': 'https://ec.europa.eu/consumers/odr',
	'invoice.seriesPrefix': 'BSL',
	'invoice.issuerPlace': 'București',
	'invoice.vatStandardRates': '2025-08-01 21',
	// NEXT-8: shipping must be a conscious pricing decision before launch.
	'shop.shippingStandardPriceBani': 1990
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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	await db.insert(users).values({ id: STAFF.id, name: 'Settings Admin', email: STAFF.email });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('settings service (integration)', () => {
	beforeEach(async () => {
		await db.delete(siteSettings);
	});

	it('reads defaults from an empty table, then what was saved', async () => {
		expect(await loadSettings({ db })).toEqual(settingsDefaults());

		const saved = await saveSettings({ db }, { 'company.legalName': 'Exemplu SRL' }, STAFF.id);
		expect(saved.ok).toBe(true);
		const settings = await loadSettings({ db });
		expect(settings['company.legalName']).toBe('Exemplu SRL');
	});

	it('a numeric-looking text value (a bare CUI) round-trips through jsonb as TEXT', async () => {
		// node-postgres hands drizzle the jsonb string already parsed and the
		// jsonb column re-parses it, so "12345676" would come back as the
		// number 12345676 and a text key would silently fall back to its
		// default (an unregistered issuer's bare CUI vanished). The read path
		// coerces by the registry kind.
		await saveSettings({ db }, { 'company.cui': '12345676' }, STAFF.id);
		expect((await loadSettings({ db }))['company.cui']).toBe('12345676');
		expect((await loadSettingsForAdmin({ db })).settings['company.cui']).toBe('12345676');
	});

	it('upserts with audit fields and reports who saved last', async () => {
		await saveSettings({ db }, { 'company.legalName': 'Prima SRL' }, STAFF.id);
		await saveSettings({ db }, { 'company.legalName': 'A Doua SRL' }, STAFF.id);

		const rows = await db.select().from(siteSettings);
		expect(rows).toHaveLength(1);
		expect(rows[0].value).toBe('A Doua SRL');
		expect(rows[0].updatedBy).toBe(STAFF.id);
		expect(rows[0].updatedAt).toBeInstanceOf(Date);

		const { settings, audit } = await loadSettingsForAdmin({ db });
		expect(settings['company.legalName']).toBe('A Doua SRL');
		expect(audit?.byEmail).toBe(STAFF.email);
	});

	it('writes nothing when any entry is invalid', async () => {
		const result = await saveSettings(
			{ db },
			{ 'company.legalName': 'Exemplu SRL', 'invoice.vatStandardRates': '2025-08-01 0' },
			STAFF.id
		);
		expect(result).toEqual({
			ok: false,
			error: 'invalid-value',
			detail: 'invoice.vatStandardRates: invalid-vat-rate'
		});
		expect(await db.select().from(siteSettings)).toHaveLength(0);
	});

	it('seeds placeholders only where missing — never over operator edits', async () => {
		const first = await seedPlaceholderSettings(db);
		expect(first).toBeGreaterThan(0);

		await saveSettings({ db }, { 'company.legalName': 'Exemplu SRL' }, STAFF.id);
		const again = await seedPlaceholderSettings(db);
		expect(again).toBe(0);
		expect((await loadSettings({ db }))['company.legalName']).toBe('Exemplu SRL');
	});
});

describe('settings launch rule (integration)', () => {
	beforeEach(async () => {
		await db.delete(siteSettings);
	});

	it('fails while launch-required settings are unset or still the seeded placeholder', async () => {
		// Nothing seeded: every launch-required key is reported as not set.
		const unset = await settingsLaunchProblems({ db });
		expect(unset.length).toBe(LAUNCH_REQUIRED_SETTING_KEYS.length);
		expect(unset.join('\n')).toMatch(/"company\.cui" is not set/);

		// Seeded placeholders are refused too — and the numeric key with no
		// placeholder (the VAT rate) keeps its "not set" line.
		await seedPlaceholderSettings(db);
		const placeholders = await settingsLaunchProblems({ db });
		expect(placeholders.length).toBe(LAUNCH_REQUIRED_SETTING_KEYS.length);
		expect(placeholders.join('\n')).toMatch(/"company\.cui" still holds the seeded placeholder/);
		expect(placeholders.join('\n')).toMatch(/"invoice\.vatStandardRates" is not set/);
	});

	it('flags an invalid stored value, and passes once every key is really set', async () => {
		await seedPlaceholderSettings(db);
		await saveSettings({ db }, VALID_LAUNCH_VALUES, STAFF.id);
		expect(await settingsLaunchProblems({ db })).toEqual([]);

		// A value that dodged validation (written by hand) is still refused.
		await db
			.update(siteSettings)
			.set({ value: 'not-a-url' })
			.where(sql`${siteSettings.key} = 'legal.anpcSalUrl'`);
		const problems = await settingsLaunchProblems({ db });
		expect(problems).toEqual([
			'site setting "legal.anpcSalUrl" has an invalid value (invalid-url) — fix it at /admin/settings'
		]);
	});

	it('flags a CUI whose RO prefix contradicts the VAT-registration flag (FIX-12)', async () => {
		await seedPlaceholderSettings(db);
		await saveSettings({ db }, VALID_LAUNCH_VALUES, STAFF.id);
		expect(await settingsLaunchProblems({ db })).toEqual([]);

		await saveSettings({ db }, { 'company.vatRegistered': false }, STAFF.id);
		const prefixed = await settingsLaunchProblems({ db });
		expect(prefixed).toHaveLength(1);
		expect(prefixed[0]).toMatch(/"company\.cui".*RO prefix.*"company\.vatRegistered"/);

		await saveSettings({ db }, { 'company.cui': '12345676' }, STAFF.id);
		expect(await settingsLaunchProblems({ db })).toEqual([]);

		await saveSettings({ db }, { 'company.vatRegistered': true }, STAFF.id);
		expect(await settingsLaunchProblems({ db })).toHaveLength(1);
	});

	it('flags a București seat whose city names no sector (CIUS-RO wants SECTORn)', async () => {
		await seedPlaceholderSettings(db);
		await saveSettings({ db }, { ...VALID_LAUNCH_VALUES, 'company.city': 'București' }, STAFF.id);
		const problems = await settingsLaunchProblems({ db });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/"company\.city".*sector/i);
		await saveSettings({ db }, { 'company.city': 'Sector 2' }, STAFF.id);
		expect(await settingsLaunchProblems({ db })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// FIX-18: the auto-migrated standard-rate schedule (review 2026-09-05 #2)
// ---------------------------------------------------------------------------

/**
 * Replays the backfill statement of the committed migration 0024 — the one
 * that turns a legacy `invoice.vatRateBp` row into a one-line schedule dated
 * 2025-08-01 — against the current table, exactly as an upgrade would.
 */
async function replayVatBackfill(): Promise<void> {
	const migration = readFileSync(
		path.resolve(import.meta.dirname, '../../../../drizzle/0024_vat_model.sql'),
		'utf8'
	);
	const backfill = migration
		.split('--> statement-breakpoint')
		.find((statement) => statement.includes('INSERT INTO "site_settings"'));
	if (!backfill) throw new Error('0024_vat_model.sql no longer carries the backfill INSERT');
	await db.execute(sql.raw(backfill));
}

describe('auto-migrated VAT schedule detector (pure)', () => {
	const at = new Date('2025-03-01T10:00:00Z');
	const legacy = { key: 'invoice.vatRateBp', value: 1900, updatedAt: at };
	const migrated = { key: 'invoice.vatStandardRates', value: '2025-08-01 19', updatedAt: at };

	it('is true for the single 2025-08-01 line carrying the legacy rate that was never re-saved', () => {
		expect(autoMigratedVatSchedule([legacy, migrated])).toBe(true);
	});

	it('is false once the operator re-saved the schedule (a later updated_at), even unchanged', () => {
		const resaved = { ...migrated, updatedAt: new Date('2026-09-05T08:00:00Z') };
		expect(autoMigratedVatSchedule([legacy, resaved])).toBe(false);
	});

	it('is false when the schedule was edited, has no legacy row, or is missing', () => {
		const edited = { ...migrated, value: '2025-08-01 19\n2026-01-01 21' };
		expect(autoMigratedVatSchedule([legacy, edited])).toBe(false);
		expect(autoMigratedVatSchedule([legacy, { ...migrated, value: '2025-08-01 21' }])).toBe(false);
		expect(autoMigratedVatSchedule([migrated])).toBe(false);
		expect(autoMigratedVatSchedule([legacy])).toBe(false);
		expect(autoMigratedVatSchedule([])).toBe(false);
	});
});

describe('auto-migrated VAT schedule: launch rule and admin flag (integration)', () => {
	beforeEach(async () => {
		await db.delete(siteSettings);
	});

	it('an upgraded pre-2025-08 install is refused by launch:check until the schedule is saved', async () => {
		await seedPlaceholderSettings(db);
		await saveSettings({ db }, VALID_LAUNCH_VALUES, STAFF.id);
		// The pre-FIX-12 installation: a saved 19 % rate, and no schedule row yet.
		await db.delete(siteSettings).where(sql`${siteSettings.key} = 'invoice.vatStandardRates'`);
		await db.insert(siteSettings).values({
			key: 'invoice.vatRateBp',
			value: 1900,
			updatedAt: new Date('2025-03-01T10:00:00Z'),
			updatedBy: STAFF.id
		});
		await replayVatBackfill();
		expect((await loadSettings({ db }))['invoice.vatStandardRates']).toBe('2025-08-01 19');

		const problems = await settingsLaunchProblems({ db });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/"invoice\.vatStandardRates".*migrat.*19/);
		expect(problems[0]).toMatch(/\/admin\/settings/);
		expect((await loadSettingsForAdmin({ db })).vatScheduleAutoMigrated).toBe(true);

		// The operator opens Settings → Invoice, confirms the schedule and saves.
		await saveSettings(
			{ db },
			{ 'invoice.vatStandardRates': '2025-08-01 19\n2026-01-01 21' },
			STAFF.id
		);
		expect(await settingsLaunchProblems({ db })).toEqual([]);
		expect((await loadSettingsForAdmin({ db })).vatScheduleAutoMigrated).toBe(false);
	});

	it('a schedule the operator saved themselves is never flagged', async () => {
		await seedPlaceholderSettings(db);
		await saveSettings({ db }, VALID_LAUNCH_VALUES, STAFF.id);
		expect(await settingsLaunchProblems({ db })).toEqual([]);
		expect((await loadSettingsForAdmin({ db })).vatScheduleAutoMigrated).toBe(false);
	});
});
