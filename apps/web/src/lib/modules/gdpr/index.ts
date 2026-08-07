// GDPR module: cookie-consent state, banner + revocation manager, and the
// cookie inventory the policy page renders. Subscriber data erasure lives
// in ./erase (node-safe service used by the `pnpm subscriber:delete` CLI).
export { default as CookieConsent } from './CookieConsent.svelte';
export { default as ConsentManager } from './ConsentManager.svelte';
export { default as CookieTable } from './CookieTable.svelte';
export { COOKIE_INVENTORY, isInventoriedCookie, type CookieInventoryEntry } from './cookies.ts';
export {
	analyticsAllowed,
	CONSENT_COOKIE,
	consentCookieString,
	consentFromCookieHeader,
	parseCookieConsent,
	type CookieConsentValue
} from './consent.ts';
