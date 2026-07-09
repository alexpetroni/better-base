// GDPR module: cookie-consent state + banner. Subscriber data erasure lives
// in ./erase (node-safe service used by the `pnpm subscriber:delete` CLI).
export { default as CookieConsent } from './CookieConsent.svelte';
export {
	analyticsAllowed,
	CONSENT_COOKIE,
	consentCookieString,
	parseCookieConsent,
	type CookieConsentValue
} from './consent.ts';
