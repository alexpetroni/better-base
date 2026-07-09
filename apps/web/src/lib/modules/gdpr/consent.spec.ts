import { describe, expect, it } from 'vitest';
import {
	analyticsAllowed,
	CONSENT_COOKIE,
	CONSENT_MAX_AGE_SECONDS,
	consentCookieString,
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

describe('consentCookieString', () => {
	it('writes a lax, site-wide, ~6-month cookie', () => {
		expect(consentCookieString('granted')).toBe(
			`${CONSENT_COOKIE}=granted; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`
		);
		expect(CONSENT_MAX_AGE_SECONDS).toBe(180 * 24 * 3600);
	});
});
