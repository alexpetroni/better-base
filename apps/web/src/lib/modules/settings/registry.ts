import { CUI_PATTERN } from '../../util/cui.ts';
import { parseLeiToCents } from '../../util/money.ts';

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
	'required' | 'invalid-value' | 'invalid-url' | 'invalid-email' | 'invalid-number' | 'invalid-cui';

/**
 * `kind` drives both the admin form control and the validators:
 * - `text` / `multiline`: plain string (input vs textarea);
 * - `url` / `email`: string with shape validation;
 * - `boolean`: checkbox;
 * - `int`: plain integer typed as-is;
 * - `bani`: integer bani, entered as lei ("49,90" → 4990);
 * - `percentBp`: integer basis points, entered as percent ("21" → 2100) —
 *   VAT math stays integer math, the form never stores a float.
 */
export type SettingKind =
	'text' | 'multiline' | 'url' | 'email' | 'boolean' | 'int' | 'bani' | 'percentBp';

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
		  }
		| { kind: 'url' | 'email'; default: string }
		| { kind: 'boolean'; default: boolean }
		| { kind: 'int' | 'bani' | 'percentBp'; default: number; min: number; max?: number }
	);

export const SETTINGS_PLACEHOLDER_PREFIX = 'PLACEHOLDER';

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
	'company.cui': {
		kind: 'text',
		default: '',
		launchRequired: true,
		clientSafe: true,
		pattern: CUI_PATTERN,
		patternCode: 'invalid-cui',
		placeholder: ph('CUI / codul fiscal (ex. RO12345678)')
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
	'company.address': {
		kind: 'multiline',
		default: '',
		launchRequired: true,
		clientSafe: true,
		placeholder: ph('adresa sediului social')
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
	// Standard RO VAT rate in basis points (21% since 2025-08). Launch-required
	// with no placeholder: the operator must consciously save the rate that
	// applies to THIS entity before launch:check goes green.
	'invoice.vatRateBp': {
		kind: 'percentBp',
		default: 2100,
		min: 0,
		max: 10_000,
		launchRequired: true,
		clientSafe: false
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
		launchRequired: false,
		clientSafe: true
	},
	// Launch-required with no placeholder (like invoice.vatRateBp): shipping
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
		launchRequired: false,
		clientSafe: true
	},
	'shop.shippingExpressName': {
		kind: 'text',
		default: '',
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
	'shop.shippingExpressEta': { kind: 'text', default: '', launchRequired: false, clientSafe: true },
	'shop.shippingNote': { kind: 'multiline', default: '', launchRequired: false, clientSafe: true }
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
		case 'percentBp':
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
			return null;
		}
	}
}

export type ParsedSettingInput =
	{ ok: true; value: SettingJsonValue } | { ok: false; code: SettingErrorCode };

/**
 * Convert an admin-form input into the stored primitive: lei strings become
 * bani, percent strings become basis points (integer math via
 * `parseLeiToCents` — two decimals is exactly the bp scale), checkboxes become
 * booleans. Bounds/shape checks stay in `validateSettingValue`.
 */
export function parseSettingInput(key: SettingKey, raw: string | boolean): ParsedSettingInput {
	const spec: SettingSpec = SETTINGS_REGISTRY[key];
	if (spec.kind === 'boolean') {
		return typeof raw === 'boolean'
			? { ok: true, value: raw }
			: { ok: false, code: 'invalid-value' };
	}
	if (typeof raw !== 'string') return { ok: false, code: 'invalid-value' };
	const trimmed = raw.trim();
	switch (spec.kind) {
		case 'int': {
			if (!/^\d{1,9}$/.test(trimmed)) return { ok: false, code: 'invalid-number' };
			return { ok: true, value: Number(trimmed) };
		}
		case 'bani':
		case 'percentBp': {
			const value = parseLeiToCents(trimmed);
			return value === null ? { ok: false, code: 'invalid-number' } : { ok: true, value };
		}
		default:
			return { ok: true, value: trimmed };
	}
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
		if (typeof row.value !== typeof settings[row.key]) continue;
		// The typeof guard above proves the primitive matches the spec's default.
		(settings as Record<SettingKey, SettingJsonValue>)[row.key] = row.value as SettingJsonValue;
	}
	return settings;
}

/** The explicit client boundary: exactly the keys marked `clientSafe`. */
export function clientSafeSettings(settings: SiteSettings): PublicSiteSettings {
	return Object.fromEntries(
		KEYS.filter((key) => SETTINGS_REGISTRY[key].clientSafe).map((key) => [key, settings[key]])
	) as PublicSiteSettings;
}
