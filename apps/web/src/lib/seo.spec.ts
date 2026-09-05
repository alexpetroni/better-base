import { describe, expect, it } from 'vitest';
import { hreflangAlternates } from './seo.ts';

// FIX-15 (audit P1 'hreflang en points at Romanian pages'): alternates are
// only honest when the site really has more than one locale AND paraglide
// resolves the locale from the URL — otherwise `/en/…` is the same Romanian
// page with a canonical back to the base URL.
describe('hreflangAlternates', () => {
	const hrefFor = (locale: string) => `https://s.test/${locale}/x`;

	it('emits nothing for a single-locale site', () => {
		expect(hreflangAlternates(['ro'], ['cookie', 'url', 'baseLocale'], 'ro', hrefFor)).toEqual([]);
	});

	it('emits nothing when the url strategy is not active', () => {
		expect(hreflangAlternates(['ro', 'en'], ['cookie', 'baseLocale'], 'ro', hrefFor)).toEqual([]);
	});

	it('emits one alternate per locale plus x-default when both hold', () => {
		expect(hreflangAlternates(['ro', 'en'], ['url', 'baseLocale'], 'ro', hrefFor)).toEqual([
			{ hreflang: 'ro', href: 'https://s.test/ro/x' },
			{ hreflang: 'en', href: 'https://s.test/en/x' },
			{ hreflang: 'x-default', href: 'https://s.test/ro/x' }
		]);
	});
});
