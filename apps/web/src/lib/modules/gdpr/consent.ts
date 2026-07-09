/**
 * Cookie-consent state, pure and unit-testable. The platform ships NO
 * analytics script yet — this module is the consent state plus the hook
 * point: when analytics land, they must load ONLY if `analyticsAllowed()`
 * says so (see `CookieConsent.svelte` for where the decision is surfaced).
 *
 * Strictly-necessary cookies (cart, chat session, admin session) do not need
 * consent and are unaffected by this banner.
 */

export const CONSENT_COOKIE = 'cookie_consent';

/** ~6 months — after that the banner asks again. */
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 3600;

export type CookieConsentValue = 'granted' | 'denied';

/** Parse a raw cookie value; anything unknown means "not decided yet". */
export function parseCookieConsent(raw: string | undefined | null): CookieConsentValue | null {
	return raw === 'granted' || raw === 'denied' ? raw : null;
}

/**
 * THE analytics hook point: any future analytics/marketing script must gate
 * its loading on this returning true. No decision = no analytics.
 */
export function analyticsAllowed(value: CookieConsentValue | null): boolean {
	return value === 'granted';
}

/** `document.cookie` assignment string for the visitor's decision. */
export function consentCookieString(value: CookieConsentValue): string {
	return `${CONSENT_COOKIE}=${value}; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
}
