import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { Result } from '../../util/result.ts';
import { users } from '../auth/schema.ts';
import {
	isSettingKey,
	isSettingsPlaceholder,
	LAUNCH_REQUIRED_SETTING_KEYS,
	mergeSettings,
	settingsConsistencyProblems,
	storedSettingValue,
	validateSettingValue,
	type SettingJsonValue,
	type SettingKey,
	type SiteSettings
} from './registry.ts';
import { siteSettings } from './schema.ts';
import { parseVatRateSchedule } from '../../util/vat-rates.ts';

export interface SettingsDeps {
	db: Db;
}

export type SettingsError = 'unknown-key' | 'invalid-value';
export type SettingsResult<T> = Result<T, SettingsError>;

/** Every setting merged over the declared defaults — ONE query. */
export async function loadSettings(deps: SettingsDeps): Promise<SiteSettings> {
	const rows = await deps.db
		.select({ key: siteSettings.key, value: siteSettings.value })
		.from(siteSettings);
	return mergeSettings(rows);
}

/**
 * Request-scoped loader for `event.locals.settings`: the first call queries,
 * every later call in the same request shares the promise, and nothing
 * outlives the request — safe on serverless where a module-level cache would
 * serve a stale config after the operator saves.
 */
export function createSettingsLoader(getDb: () => Db): () => Promise<SiteSettings> {
	let loaded: Promise<SiteSettings> | undefined;
	return () => (loaded ??= loadSettings({ db: getDb() }));
}

export interface SettingsAudit {
	at: Date;
	/** Null when the last writer was the seed or a since-deleted user. */
	byEmail: string | null;
}

/** The pre-FIX-12 single-rate key migration 0024 backfills the schedule from. */
const LEGACY_VAT_RATE_KEY = 'invoice.vatRateBp';
/** The `from` day the 0024 backfill stamps on the derived one-line schedule. */
const VAT_BACKFILL_FROM = '2025-08-01';

/**
 * Is the stored standard-rate schedule still the one migration 0024 derived
 * from the legacy `invoice.vatRateBp` row, never confirmed by an operator
 * (FIX-18, review 2026-09-05 #2)? That backfill freezes whatever rate the
 * pre-2025-08 installation had saved — 19 % on most — as the rate for every
 * later order. The shape is unmistakable: a single line dated 2025-08-01
 * carrying exactly the legacy rate, on a row whose `updated_at` still equals
 * the legacy row's (the migration copies it; any operator save stamps a new
 * one). Re-saving the schedule, even unchanged, is the confirmation.
 */
export function autoMigratedVatSchedule(
	rows: Array<{ key: string; value: unknown; updatedAt: Date }>
): boolean {
	const legacy = rows.find((row) => row.key === LEGACY_VAT_RATE_KEY);
	const schedule = rows.find((row) => row.key === 'invoice.vatStandardRates');
	if (!legacy || !schedule || typeof legacy.value !== 'number') return false;
	if (typeof schedule.value !== 'string') return false;
	const parsed = parseVatRateSchedule(schedule.value);
	if (!parsed || parsed.length !== 1) return false;
	const [entry] = parsed;
	return (
		entry.from === VAT_BACKFILL_FROM &&
		entry.bp === legacy.value &&
		schedule.updatedAt.getTime() === legacy.updatedAt.getTime()
	);
}

/**
 * The admin screen's read: values plus the most recent save's who/when,
 * resolved in the same single query (left join to users).
 */
export async function loadSettingsForAdmin(deps: SettingsDeps): Promise<{
	settings: SiteSettings;
	audit: SettingsAudit | null;
	/** The standard-rate schedule is still the 0024 backfill — the form warns on that field. */
	vatScheduleAutoMigrated: boolean;
}> {
	const rows = await deps.db
		.select({
			key: siteSettings.key,
			value: siteSettings.value,
			updatedAt: siteSettings.updatedAt,
			updatedBy: siteSettings.updatedBy,
			byEmail: users.email
		})
		.from(siteSettings)
		.leftJoin(users, eq(siteSettings.updatedBy, users.id));

	let audit: SettingsAudit | null = null;
	for (const row of rows) {
		// Seed rows (no author) never count as "last saved by".
		if (row.updatedBy === null) continue;
		if (!audit || row.updatedAt > audit.at) audit = { at: row.updatedAt, byEmail: row.byEmail };
	}
	return {
		settings: mergeSettings(rows),
		audit,
		vatScheduleAutoMigrated: autoMigratedVatSchedule(rows)
	};
}

/**
 * Validate and upsert the given settings as one statement. All-or-nothing:
 * any unknown key or invalid value writes NOTHING. `updatedBy` is the saving
 * staff user's id (audit).
 */
export async function saveSettings(
	deps: SettingsDeps,
	entries: Partial<Record<SettingKey, SettingJsonValue>>,
	updatedBy: string
): Promise<SettingsResult<void>> {
	const items = Object.entries(entries) as Array<[SettingKey, SettingJsonValue]>;
	for (const [key, value] of items) {
		if (!isSettingKey(key)) return { ok: false, error: 'unknown-key', detail: key };
		const code = validateSettingValue(key, value);
		if (code) return { ok: false, error: 'invalid-value', detail: `${key}: ${code}` };
	}
	if (items.length === 0) return { ok: true, value: undefined };

	const now = new Date();
	await deps.db
		.insert(siteSettings)
		.values(items.map(([key, value]) => ({ key, value, updatedAt: now, updatedBy })))
		.onConflictDoUpdate({
			target: siteSettings.key,
			set: { value: sql`excluded.value`, updatedAt: now, updatedBy }
		});
	return { ok: true, value: undefined };
}

/**
 * The launch preflight's DB rule (`pnpm launch:check`): every launch-required
 * setting must have an explicitly saved row whose value is neither the seeded
 * placeholder nor invalid. One problem line per offending key.
 */
export async function settingsLaunchProblems(deps: SettingsDeps): Promise<string[]> {
	const rows = await deps.db
		.select({ key: siteSettings.key, value: siteSettings.value, updatedAt: siteSettings.updatedAt })
		.from(siteSettings);
	const stored = new Map<string, SettingJsonValue>(rows.map((row) => [row.key, row.value]));

	const problems: string[] = [];
	for (const key of LAUNCH_REQUIRED_SETTING_KEYS) {
		if (!stored.has(key)) {
			problems.push(`site setting "${key}" is not set — fill it in at /admin/settings`);
			continue;
		}
		const value = storedSettingValue(key, stored.get(key));
		if (isSettingsPlaceholder(value)) {
			problems.push(
				`site setting "${key}" still holds the seeded placeholder — replace it at /admin/settings`
			);
			continue;
		}
		const code = validateSettingValue(key, value);
		if (code) {
			problems.push(
				`site setting "${key}" has an invalid value (${code}) — fix it at /admin/settings`
			);
		}
	}
	// Cross-key rules (the CUI prefix vs. the registration flag) — the same
	// check issuance applies, so a config that launches also invoices.
	for (const problem of settingsConsistencyProblems(mergeSettings(rows))) {
		problems.push(`site setting "${problem.key}" ${problem.message} — fix it at /admin/settings`);
	}
	// An upgrade's backfilled schedule is valid and non-placeholder, so only
	// this shape check catches the frozen legacy rate (FIX-18).
	if (autoMigratedVatSchedule(rows)) {
		const legacy = rows.find((row) => row.key === LEGACY_VAT_RATE_KEY)?.value as number;
		problems.push(
			`site setting "invoice.vatStandardRates" is still the schedule migration 0024 derived from the legacy ${legacy / 100} % rate (a single 2025-08-01 line, never re-saved) — open /admin/settings → Invoice, confirm the standard-rate schedule that applies to this entity and save it`
		);
	}
	return problems;
}
