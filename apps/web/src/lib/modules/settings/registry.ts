import { cuiPrefixMismatch, isValidCui } from '../../util/cui.ts';
import { parseLeiToCents } from '../../util/money.ts';
import { BUCHAREST_COUNTY_CODE, bucharestSector, isRoCountyCode } from '../../util/ro-counties.ts';
import { parseVatRateSchedule } from '../../util/vat-rates.ts';

/**
 * THE registry of site settings: every key the app may read or the operator
 * may edit is declared here — its value kind, default, whether it must be set
 * before launch and whether it is safe to expose to the client. Reading an
 * unknown key is a compile-time error (`SettingKey`), reading a never-set key
 * returns the declared default (`mergeSettings`).
 *
 * Settings are per-deployment DATA (better-sleep and better-life are different
 * legal entities): company identification, ANPC/SOL links, invoice series and
 * VAT rate are never string literals in a route or component — they live in
 * `site_settings` rows edited at /admin/settings, with the defaults below as
 * the only fallback. Later phases add keys here (plus paraglide labels and a
 * form field) without a migration — storage is one jsonb row per key.
 *
 * Hand-rolled validators (no Zod in this repo) return error CODES; the admin
 * screen maps them to paraglide messages (`admin_settings_err_*`).
 */

/** What a setting's jsonb value may be — one JSON primitive per key. */
export type SettingJsonValue = string | number | boolean;

export type SettingErrorCode =
	| 'required'
	| 'invalid-value'
	| 'invalid-url'
	| 'invalid-email'
	| 'invalid-number'
	| 'invalid-cui'
	| 'invalid-vat-rate'
	| 'invalid-county'
	| 'too-long';

/**
 * `kind` drives both the admin form control and the validators:
 * - `text` / `multiline`: plain string (input vs textarea);
 * - `url` / `email`: string with shape validation;
 * - `boolean`: checkbox;
 * - `int`: plain integer typed as-is;
 * - `bani`: integer bani, entered as lei ("49,90" → 4990) — money stays
 *   integer math, the form never stores a float.
 * Text kinds may add a `validate` hook for rules a regex cannot express
 * (the CUI checksum, the VAT rate schedule).
 */
export type SettingKind = 'text' | 'multiline' | 'url' | 'email' | 'boolean' | 'int' | 'bani';

interface BaseSpec {
	/** Must be set (and not the seeded placeholder) before launch — enforced by `pnpm launch:check`. */
	launchRequired: boolean;
	/** May reach `PageData` / the rendered HTML. Everything else stays server-only. */
	clientSafe: boolean;
	/**
	 * Seeded starter value for launch-required text keys, always prefixed with
	 * `PLACEHOLDER` so launch:check can refuse to launch on it. Keys without a
	 * placeholder are simply "not set" until the operator saves them.
	 */
	placeholder?: string;
}

export type SettingSpec = BaseSpec &
	(
		| {
				kind: 'text' | 'multiline';
				default: string;
				pattern?: RegExp;
				patternCode?: SettingErrorCode;
				/** Upper bound on the stored (trimmed) length; `too-long` beyond it. */
				maxLength?: number;
				/** Rule beyond a regex, on the trimmed non-empty value; returns the error code or null. */
				validate?: (value: string) => SettingErrorCode | null;
		  }
		| { kind: 'url' | 'email'; default: string }
		| { kind: 'boolean'; default: boolean }
		| { kind: 'int' | 'bani'; default: number; min: number; max?: number }
	);

export const SETTINGS_PLACEHOLDER_PREFIX = 'PLACEHOLDER';

/**
 * Shipping option name / ETA caps (audit 2026-09-03 P2): Stripe rejects a
 * shipping rate whose display name exceeds 100 characters, which would fail
 * EVERY checkout. The name and the ETA are composed as `name (eta)` and the
 * composer trims at Stripe's limit as the last line of defense.
 */
export const SHIPPING_NAME_MAX_LENGTH = 60;
export const SHIPPING_ETA_MAX_LENGTH = 40;

const ph = (hint: string) => `${SETTINGS_PLACEHOLDER_PREFIX} — ${hint}`;

export const SETTINGS_REGISTRY = {
	// --- company.* — legal identification of the operating entity -----------
	'company.legalName': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('denumirea legală a companiei (ex. Exemplu SRL)')
	},
	// Shape AND mod-11 checksum (FIX-12); the RO prefix must agree with
	// `company.vatRegistered` — a cross-key rule, see settingsConsistencyProblems.
	'company.cui': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: true,
		validate: (value) => (isValidCui(value) ? null : 'invalid-cui'),
		placeholder: ph('CUI / codul fiscal (ex. RO12345676)')
	},
	'company.vatRegistered': {
		kind: 'boolean',
		default: false,
		launchRequired: false,
		clientSafe: true
	},
	'company.regCom': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('nr. Registrul Comerțului (ex. J40/1234/2024)')
	},
	// The public display form of the seat (footer, legal pages)…
	'company.address': {
		kind: 'multiline',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('adresa sediului social')
	},
	// …and its STRUCTURED fiscal form (FIX-12): CIUS-RO wants street, city,
	// the ISO 3166-2:RO county code and the postal code on the seller party;
	// for a București seat the city is the sector (cross-key rule below).
	'company.street': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		placeholder: ph('strada și numărul sediului social (ex. Str. Exemplu nr. 1)')
	},
	'company.city': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		placeholder: ph('localitatea sediului (pentru București: Sector 1…6)')
	},
	'company.county': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		validate: (value) => (isRoCountyCode(value) ? null : 'invalid-county'),
		placeholder: ph('județul sediului ca și cod ISO 3166-2:RO (ex. RO-B, RO-CJ)')
	},
	'company.postalCode': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		pattern: /^[0-9A-Za-z][0-9A-Za-z -]{2,11}$/,
		patternCode: 'invalid-value',
		placeholder: ph('codul poștal al sediului (ex. 010101)')
	},
	// Legea 31/1990 art. 74: an SRL/SA states its share capital on every
	// document. Printed under Reg. Com.; a PFA/II states that it does not apply.
	'company.shareCapital': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		placeholder: ph('capitalul social subscris și vărsat (ex. 200 lei; PFA/II: „nu se aplică”)')
	},
	'company.contactEmail': {
		kind: 'email',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('emailul de contact')
	},
	'company.contactPhone': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('telefonul de contact')
	},
	'company.iban': { kind: 'text', default: '', launchRequired: false, clientSafe: false },
	'company.bank': { kind: 'text', default: '', launchRequired: false, clientSafe: false },

	// --- legal.* — consumer-protection links the footer must carry ----------
	'legal.anpcSalUrl': {
		kind: 'url',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('URL-ul ANPC SAL (https://anpc.ro/ce-este-sal/)')
	},
	'legal.anpcSolUrl': {
		kind: 'url',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('URL-ul platformei SOL (https://ec.europa.eu/consumers/odr)')
	},
	'legal.extraNotices': {
		kind: 'multiline',
		default: '',
		launchRequired: false,
		clientSafe: true
	},

	// --- invoice.* — declared here, consumed by the invoicing phase ---------
	'invoice.seriesPrefix': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		placeholder: ph('seria facturilor (ex. BSL)')
	},
	'invoice.nextNumber': {
		kind: 'int',
		default: 1,
		min: 1,
		launchRequired: false,
		clientSafe: false
	},
	'invoice.issuerPlace': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: false,
		placeholder: ph('locul emiterii facturilor (ex. București)')
	},
	// The STANDARD VAT rate, effective-dated (FIX-12, replaces the single
	// `invoice.vatRateBp`): one `YYYY-MM-DD percent` line per rate change,
	// validated against the RO rate allowlist (never zero — a registered
	// issuer's 0 % line would be category Z by accident). Issuance selects
	// the rate in force on the ORDER date. Launch-required with no
	// placeholder: the operator must consciously save the schedule that
	// applies to THIS entity before launch:check goes green. Per-product
	// reduced rates live on `products.vat_rate_bp`.
	'invoice.vatStandardRates': {
		kind: 'multiline',
		default: '2025-08-01 21',
		launchRequired: true,
		clientSafe: false,
		validate: (value) => (parseVatRateSchedule(value) ? null : 'invalid-vat-rate')
	},
	'invoice.paymentTermsNote': {
		kind: 'multiline',
		default: '',
		launchRequired: false,
		clientSafe: false
	},
	// Mention printed on invoices while the entity is NOT VAT-registered
	// (`company.vatRegistered` off) — snapshotted into each invoice at issue.
	'invoice.vatUnregisteredMention': {
		kind: 'text',
		default: 'Neplătitor de TVA',
		launchRequired: false,
		clientSafe: false
	},

	// --- shop.* — shipping options offered at checkout (NEXT-8) -------------
	// Two option slots: `standard` (always offered) and `express` (offered only
	// while its name is non-empty). Prices are gross bani, charged by Stripe on
	// top of the goods. The free threshold applies to the STANDARD option only —
	// express stays a paid upgrade. See modules/shop/shipping.ts.
	'shop.freeShippingThresholdBani': {
		kind: 'bani',
		default: 0,
		min: 0,
		launchRequired: false,
		clientSafe: true
	},
	'shop.shippingStandardName': {
		kind: 'text',
		default: 'Curier standard',
		maxLength: SHIPPING_NAME_MAX_LENGTH,
		launchRequired: false,
		clientSafe: true
	},
	// Launch-required with no placeholder (like invoice.vatStandardRates): shipping
	// must be a conscious pricing decision, not free by accident — the operator
	// has to save the rate (0 is a valid, deliberate "we ship free") before
	// launch:check goes green.
	'shop.shippingStandardPriceBani': {
		kind: 'bani',
		default: 0,
		min: 0,
		launchRequired: true,
		clientSafe: true
	},
	'shop.shippingStandardEta': {
		kind: 'text',
		default: '1-3 zile lucrătoare',
		maxLength: SHIPPING_ETA_MAX_LENGTH,
		launchRequired: false,
		clientSafe: true
	},
	'shop.shippingExpressName': {
		kind: 'text',
		default: '',
		maxLength: SHIPPING_NAME_MAX_LENGTH,
		launchRequired: false,
		clientSafe: true
	},
	'shop.shippingExpressPriceBani': {
		kind: 'bani',
		default: 0,
		min: 0,
		launchRequired: false,
		clientSafe: true
	},
	'shop.shippingExpressEta': {
		kind: 'text',
		default: '',
		maxLength: SHIPPING_ETA_MAX_LENGTH,
		launchRequired: false,
		clientSafe: true
	},
	'shop.shippingNote': { kind: 'multiline', default: '', launchRequired: false, clientSafe: true },
	// Payment methods Stripe Checkout may offer (FIX-10). Off = every session
	// is pinned to `card`, so a delayed method (bank debit, voucher…) enabled
	// in the Stripe dashboard can never put orders on the async-payment path
	// by accident; on = the dashboard configuration decides (the async events
	// are handled either way — this is the operator's conscious choice).
	'shop.allowAllPaymentMethods': {
		kind: 'boolean',
		default: false,
		launchRequired: false,
		clientSafe: false
	}
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;

type Widen<T> = T extends string ? string : T extends number ? number : boolean;

export type SettingValue<K extends SettingKey> = Widen<(typeof SETTINGS_REGISTRY)[K]['default']>;

/** Every setting, typed per key — what `locals.settings()` resolves to. */
export type SiteSettings = { [K in SettingKey]: SettingValue<K> };

export type ClientSafeSettingKey = {
	[K in SettingKey]: (typeof SETTINGS_REGISTRY)[K]['clientSafe'] extends true ? K : never;
}[SettingKey];

/** The subset of settings that may reach `PageData` — nothing else ever does. */
export type PublicSiteSettings = Pick<SiteSettings, ClientSafeSettingKey>;

const KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
	return Object.hasOwn(SETTINGS_REGISTRY, key);
}

/** All registered keys, in declaration (= form) order. */
export function settingKeys(): SettingKey[] {
	return [...KEYS];
}

export const LAUNCH_REQUIRED_SETTING_KEYS: readonly SettingKey[] = KEYS.filter(
	(key) => SETTINGS_REGISTRY[key].launchRequired
);

/** Form sections, derived from the key prefix before the dot. */
export const SETTING_GROUPS = ['company', 'legal', 'invoice', 'shop'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export function isSettingGroup(value: string): value is SettingGroup {
	return (SETTING_GROUPS as readonly string[]).includes(value);
}

export function settingGroupKeys(group: SettingGroup): SettingKey[] {
	return KEYS.filter((key) => key.startsWith(`${group}.`));
}

export function settingsDefaults(): SiteSettings {
	return Object.fromEntries(
		KEYS.map((key) => [key, SETTINGS_REGISTRY[key].default])
	) as SiteSettings;
}

/** Was this value seeded as a to-be-replaced placeholder? */
export function isSettingsPlaceholder(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith(SETTINGS_PLACEHOLDER_PREFIX);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Validate a STORED value (the jsonb primitive) against its spec. Returns an
 * error code or null. Used on every save and by the launch preflight; reads
 * never validate — a stored placeholder must surface, not vanish.
 */
export function validateSettingValue(key: SettingKey, value: unknown): SettingErrorCode | null {
	const spec: SettingSpec = SETTINGS_REGISTRY[key];
	switch (spec.kind) {
		case 'boolean':
			return typeof value === 'boolean' ? null : 'invalid-value';
		case 'int':
		case 'bani':
			if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid-number';
			if (value < spec.min || (spec.max !== undefined && value > spec.max)) {
				return 'invalid-number';
			}
			return null;
		default: {
			if (typeof value !== 'string') return 'invalid-value';
			const trimmed = value.trim();
			if (!trimmed) return spec.launchRequired ? 'required' : null;
			if (spec.kind === 'url' && !isHttpUrl(trimmed)) return 'invalid-url';
			if (spec.kind === 'email' && !EMAIL_PATTERN.test(trimmed)) return 'invalid-email';
			if ('pattern' in spec && spec.pattern && !spec.pattern.test(trimmed)) {
				return spec.patternCode ?? 'invalid-value';
			}
			if ('maxLength' in spec && spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
				return 'too-long';
			}
			if ('validate' in spec && spec.validate) return spec.validate(trimmed);
			return null;
		}
	}
}

export interface SettingConsistencyProblem {
	key: SettingKey;
	code: 'cui-prefix-mismatch' | 'bucharest-sector';
	/** Operator-facing explanation, appended after the key by launch:check. */
	message: string;
}

/**
 * Rules that span two keys, which per-key validation cannot see. Applied by
 * the launch preflight and by invoice issuance (both refuse on a hit) so the
 * two can never disagree. Today: the RO prefix on `company.cui` must agree
 * with `company.vatRegistered` — the prefix IS the VAT registration marker,
 * and an invoice must neither claim nor deny a registration the entity's
 * own flag contradicts (audit 2026-09-03 P1).
 */
export function settingsConsistencyProblems(
	settings: Pick<
		SiteSettings,
		'company.cui' | 'company.vatRegistered' | 'company.city' | 'company.county'
	>
): SettingConsistencyProblem[] {
	const problems: SettingConsistencyProblem[] = [];
	if (cuiPrefixMismatch(settings['company.cui'], settings['company.vatRegistered'])) {
		problems.push({
			key: 'company.cui',
			code: 'cui-prefix-mismatch',
			message: settings['company.vatRegistered']
				? 'lacks the RO prefix while "company.vatRegistered" is on — the prefix is the VAT registration marker; add it, or untick the flag'
				: 'carries the RO prefix while "company.vatRegistered" is off — the prefix is the VAT registration marker; remove it, or tick the flag'
		});
	}
	// CIUS-RO BR-RO-A20: under RO-B the city IS the sector.
	if (
		settings['company.county'] === BUCHAREST_COUNTY_CODE &&
		bucharestSector(settings['company.city']) === null
	) {
		problems.push({
			key: 'company.city',
			code: 'bucharest-sector',
			message:
				'names no sector while "company.county" is RO-B — e-Factura wants "Sector 1"…"Sector 6" as the București city'
		});
	}
	return problems;
}

export type ParsedSettingInput =
	{ ok: true; value: SettingJsonValue } | { ok: false; code: SettingErrorCode };

/**
 * Convert an admin-form input into the stored primitive: lei strings become
 * bani (integer math via `parseLeiToCents`), checkboxes become booleans,
 * text is trimmed. Bounds/shape checks stay in `validateSettingValue`.
 */
export function parseSettingInput(key: SettingKey, raw: string | boolean): ParsedSettingInput {
	const spec: SettingSpec = SETTINGS_REGISTRY[key];
	if (spec.kind === 'boolean') {
		return typeof raw === 'boolean'
			? { ok: true, value: raw }
			: { ok: false, code: 'invalid-value' };
	}
	if (typeof raw !== 'string') return { ok: false, code: 'invalid-value' };
	// Browsers submit textarea content with CRLF line ends; store LF.
	const trimmed = raw.replace(/\r\n?/g, '\n').trim();
	switch (spec.kind) {
		case 'int': {
			if (!/^\d{1,9}$/.test(trimmed)) return { ok: false, code: 'invalid-number' };
			return { ok: true, value: Number(trimmed) };
		}
		case 'bani': {
			const value = parseLeiToCents(trimmed);
			return value === null ? { ok: false, code: 'invalid-number' } : { ok: true, value };
		}
		default:
			return { ok: true, value: trimmed };
	}
}

/**
 * A stored jsonb value as the registry means it. node-postgres already
 * parses jsonb, and drizzle's jsonb column parses the result AGAIN when it
 * is a string — so a text setting that happens to look like JSON (a bare
 * CUI such as "12345676") comes back as a NUMBER. For a text kind that is
 * unambiguous (the registry never stores numbers under a text key), so it
 * is coerced back; every other kind is left to the type guard below.
 */
export function storedSettingValue(key: SettingKey, value: unknown): unknown {
	const kind = SETTINGS_REGISTRY[key].kind;
	const textKind = kind === 'text' || kind === 'multiline' || kind === 'url' || kind === 'email';
	return textKind && typeof value === 'number' ? String(value) : value;
}

/**
 * Merge stored rows over the declared defaults. Unknown keys (rows written by
 * a newer deploy) are ignored; a stored value whose primitive type does not
 * match its spec falls back to the default so `SiteSettings` stays honest.
 */
export function mergeSettings(rows: Array<{ key: string; value: unknown }>): SiteSettings {
	const settings = settingsDefaults();
	for (const row of rows) {
		if (!isSettingKey(row.key)) continue;
		const value = storedSettingValue(row.key, row.value);
		if (typeof value !== typeof settings[row.key]) continue;
		// The typeof guard above proves the primitive matches the spec's default.
		(settings as Record<SettingKey, SettingJsonValue>)[row.key] = value as SettingJsonValue;
	}
	return settings;
}

/** The explicit client boundary: exactly the keys marked `clientSafe`. */
export function clientSafeSettings(settings: SiteSettings): PublicSiteSettings {
	return Object.fromEntries(
		KEYS.filter((key) => SETTINGS_REGISTRY[key].clientSafe).map((key) => [key, settings[key]])
	) as PublicSiteSettings;
}
