import { env as publicEnv } from '$env/dynamic/public';
import { describe, expect, it } from 'vitest';
import { sanitizeEventProps } from './events.ts';
import { isTrackablePath, shouldLoadAnalytics } from './gate.ts';
import {
	analyticsCookieClearStrings,
	selectAnalyticsProvider,
	type AnalyticsScriptConfig
} from './select.ts';

describe('selectAnalyticsProvider', () => {
	it('defaults to the no-op provider when env is unset or empty', () => {
		expect(selectAnalyticsProvider({})).toBeNull();
		expect(selectAnalyticsProvider({ PUBLIC_ANALYTICS_PROVIDER: '' })).toBeNull();
		expect(selectAnalyticsProvider({ PUBLIC_ANALYTICS_PROVIDER: '  ' })).toBeNull();
		expect(selectAnalyticsProvider({ PUBLIC_ANALYTICS_PROVIDER: 'none' })).toBeNull();
	});

	it('stays no-op even when host/site id are present without a provider', () => {
		expect(
			selectAnalyticsProvider({
				PUBLIC_ANALYTICS_HOST: 'https://plausible.io',
				PUBLIC_ANALYTICS_SITE_ID: 'bettersleep.ro'
			})
		).toBeNull();
	});

	it('selects plausible only with the full config, normalizing a trailing slash', () => {
		const config = selectAnalyticsProvider({
			PUBLIC_ANALYTICS_PROVIDER: 'plausible',
			PUBLIC_ANALYTICS_HOST: 'https://plausible.io/',
			PUBLIC_ANALYTICS_SITE_ID: 'bettersleep.ro'
		});
		expect(config).toEqual({
			kind: 'plausible',
			src: 'https://plausible.io/js/script.js',
			attrs: { 'data-domain': 'bettersleep.ro' },
			cookieNames: []
		});
	});

	it('selects umami with its own script path and attribute', () => {
		const config = selectAnalyticsProvider({
			PUBLIC_ANALYTICS_PROVIDER: 'umami',
			PUBLIC_ANALYTICS_HOST: 'https://stats.example.com',
			PUBLIC_ANALYTICS_SITE_ID: 'abc-123'
		});
		expect(config).toEqual({
			kind: 'umami',
			src: 'https://stats.example.com/script.js',
			attrs: { 'data-website-id': 'abc-123' },
			cookieNames: []
		});
	});

	it('throws on a half-configured provider instead of silently falling back', () => {
		expect(() => selectAnalyticsProvider({ PUBLIC_ANALYTICS_PROVIDER: 'plausible' })).toThrow(
			/requires PUBLIC_ANALYTICS_HOST and PUBLIC_ANALYTICS_SITE_ID/
		);
		expect(() =>
			selectAnalyticsProvider({
				PUBLIC_ANALYTICS_PROVIDER: 'umami',
				PUBLIC_ANALYTICS_HOST: 'https://stats.example.com'
			})
		).toThrow(/PUBLIC_ANALYTICS_SITE_ID/);
	});

	it('throws on an unknown provider', () => {
		expect(() =>
			selectAnalyticsProvider({ PUBLIC_ANALYTICS_PROVIDER: 'google-analytics' })
		).toThrow(/Unknown PUBLIC_ANALYTICS_PROVIDER/);
	});

	it('never selects a real provider from the test environment', () => {
		// The suite runs with no PUBLIC_ANALYTICS_* config — the same call the
		// (public) layout makes must resolve to the no-op provider here.
		expect(
			selectAnalyticsProvider({
				PUBLIC_ANALYTICS_PROVIDER: publicEnv.PUBLIC_ANALYTICS_PROVIDER,
				PUBLIC_ANALYTICS_HOST: publicEnv.PUBLIC_ANALYTICS_HOST,
				PUBLIC_ANALYTICS_SITE_ID: publicEnv.PUBLIC_ANALYTICS_SITE_ID
			})
		).toBeNull();
	});
});

const PLAUSIBLE: AnalyticsScriptConfig = {
	kind: 'plausible',
	src: 'https://plausible.io/js/script.js',
	attrs: { 'data-domain': 'bettersleep.ro' },
	cookieNames: []
};

describe('shouldLoadAnalytics', () => {
	it('loads only with granted consent AND a configured provider', () => {
		expect(shouldLoadAnalytics(PLAUSIBLE, 'granted', '/')).toBe(true);
		expect(shouldLoadAnalytics(PLAUSIBLE, null, '/')).toBe(false);
		expect(shouldLoadAnalytics(PLAUSIBLE, 'denied', '/')).toBe(false);
		expect(shouldLoadAnalytics(null, 'granted', '/')).toBe(false);
	});

	it('excludes admin and api routes even with granted consent', () => {
		expect(shouldLoadAnalytics(PLAUSIBLE, 'granted', '/admin')).toBe(false);
		expect(shouldLoadAnalytics(PLAUSIBLE, 'granted', '/admin/settings')).toBe(false);
		expect(shouldLoadAnalytics(PLAUSIBLE, 'granted', '/api/chat')).toBe(false);
	});
});

describe('isTrackablePath', () => {
	it('excludes /admin and /api subtrees, keeps public routes', () => {
		expect(isTrackablePath('/')).toBe(true);
		expect(isTrackablePath('/blog/un-articol')).toBe(true);
		expect(isTrackablePath('/pagini/politica-de-cookie-uri')).toBe(true);
		expect(isTrackablePath('/admin')).toBe(false);
		expect(isTrackablePath('/admin/orders')).toBe(false);
		expect(isTrackablePath('/api/health')).toBe(false);
		// Prefix match must not swallow legitimate public slugs.
		expect(isTrackablePath('/administrare-somn')).toBe(true);
	});
});

describe('sanitizeEventProps', () => {
	it('drops PII-named keys and PII-shaped values, keeps the rest', () => {
		expect(
			sanitizeEventProps({
				step: 3,
				pillar: 'somn',
				email: 'x@y.ro',
				userEmail: 'x@y.ro',
				telefon: '+40 721 123 456',
				userId: 'u_123',
				contact: 'ana@exemplu.ro',
				note: 'checkout',
				ref: '0721-123-456'
			})
		).toEqual({ step: 3, pillar: 'somn', note: 'checkout' });
	});

	it('keeps boolean and numeric props untouched', () => {
		expect(sanitizeEventProps({ paid: true, total: 4990 })).toEqual({ paid: true, total: 4990 });
	});
});

describe('analyticsCookieClearStrings', () => {
	it('expires every declared provider cookie, and nothing for cookieless providers', () => {
		expect(analyticsCookieClearStrings(PLAUSIBLE)).toEqual([]);
		expect(analyticsCookieClearStrings(null)).toEqual([]);
		expect(analyticsCookieClearStrings({ ...PLAUSIBLE, cookieNames: ['_pa_sess'] })).toEqual([
			'_pa_sess=; Max-Age=0; Path=/; SameSite=Lax'
		]);
	});
});
