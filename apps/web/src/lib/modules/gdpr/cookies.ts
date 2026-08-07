/**
 * THE cookie inventory: every cookie this app sets, with its purpose and
 * lifetime. The public cookie-policy page renders its table from this list,
 * so the policy cannot drift from the code. `cookies.spec.ts` enforces the
 * other direction: it scans the source for cookie writes and cross-checks the
 * authoritative per-module constants, so a NEW cookie fails the suite until
 * it gets an entry here (and thus a row in the policy).
 *
 * Universal module (client-imported by the policy page) — cookie names of
 * server-only modules are duplicated as literals here on purpose; the spec
 * asserts they stay equal to the real constants.
 */
export interface CookieInventoryEntry {
	name: string;
	/** Suffix of the `cookie_purpose_*` / `cookie_lifetime_*` paraglide messages. */
	key: 'auth_session' | 'cart' | 'consent' | 'chat_session' | 'locale';
	/** Maximum lifetime in days (display + spec cross-check vs. code constants). */
	maxAgeDays: number;
	/** httpOnly cookies never reach client JS — legal nuance worth showing. */
	httpOnly: boolean;
}

export const COOKIE_INVENTORY: readonly CookieInventoryEntry[] = [
	// better-auth default name (no `advanced.cookiePrefix` override in
	// auth.ts); browsers show `__Secure-`-prefixed on https. 7-day default
	// session expiry.
	{ name: 'better-auth.session_token', key: 'auth_session', maxAgeDays: 7, httpOnly: true },
	{ name: 'cart', key: 'cart', maxAgeDays: 30, httpOnly: true },
	{ name: 'cookie_consent', key: 'consent', maxAgeDays: 180, httpOnly: false },
	{ name: 'chat_session', key: 'chat_session', maxAgeDays: 30, httpOnly: true },
	// Paraglide's locale override — only written if a visitor ever calls
	// setLocale (no language switcher ships today), listed for completeness.
	{ name: 'PARAGLIDE_LOCALE', key: 'locale', maxAgeDays: 400, httpOnly: false }
];

export function isInventoriedCookie(name: string): boolean {
	return COOKIE_INVENTORY.some((entry) => entry.name === name);
}
