import { describe, expect, it } from 'vitest';
import {
	analyticsAllowed,
	CONSENT_COOKIE,
	CONSENT_MAX_AGE_SECONDS,
	consentCookieString,
	consentFromCookieHeader,
	parseCookieConsent
} from './consent.ts';

describe('parseCookieConsent', () => {
	it('accepts only the two known decisions', () => {
		expect(parseCookieConsent('granted')).toBe('granted');
		expect(parseCookieConsent('denied')).toBe('denied');
	});

	it('maps everything else to "not decided"', () => {
		expect(parseCookieConsent(undefined)).toBeNull();
		expect(parseCookieConsent(null)).toBeNull();
		expect(parseCookieConsent('')).toBeNull();
		expect(parseCookieConsent('yes')).toBeNull();
		expect(parseCookieConsent('GRANTED')).toBeNull();
	});
});

describe('analyticsAllowed — the analytics hook point', () => {
	it('allows analytics ONLY on an explicit grant', () => {
		expect(analyticsAllowed('granted')).toBe(true);
		expect(analyticsAllowed('denied')).toBe(false);
		expect(analyticsAllowed(null)).toBe(false); // no decision = no analytics
	});
});

describe('consentFromCookieHeader', () => {
	it('finds the decision inside a document.cookie-style header', () => {
		expect(consentFromCookieHeader(`cart=abc; ${CONSENT_COOKIE}=granted; x=1`)).toBe('granted');
		expect(consentFromCookieHeader(`${CONSENT_COOKIE}=denied`)).toBe('denied');
	});

	it('maps a missing or mangled cookie to "not decided"', () => {
		expect(consentFromCookieHeader('')).toBeNull();
		expect(consentFromCookieHeader('cart=abc; x=1')).toBeNull();
		expect(consentFromCookieHeader(`${CONSENT_COOKIE}=maybe`)).toBeNull();
		// A cookie whose name merely ends with ours must not match.
		expect(consentFromCookieHeader(`not_${CONSENT_COOKIE}=granted`)).toBeNull();
	});
});

describe('consentCookieString', () => {
	it('writes a lax, site-wide, ~6-month cookie', () => {
		expect(consentCookieString('granted')).toBe(
			`${CONSENT_COOKIE}=granted; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`
		);
		expect(CONSENT_MAX_AGE_SECONDS).toBe(180 * 24 * 3600);
	});
});
