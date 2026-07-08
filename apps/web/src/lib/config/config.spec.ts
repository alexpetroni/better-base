import { describe, expect, it } from 'vitest';
import { CANONICAL_PILLARS, PILLARS_BY_SLUG, resolveSiteConfig } from './index.ts';

describe('resolveSiteConfig', () => {
	it('resolves the sleep site with exactly one pillar', () => {
		const site = resolveSiteConfig('sleep');
		expect(site.id).toBe('sleep');
		expect(site.pillars).toHaveLength(1);
		expect(site.name).toBeTruthy();
		expect(site.domain).toBeTruthy();
		expect(site.nav.length).toBeGreaterThan(0);
	});

	it('resolves the life site with all 9 canonical pillars', () => {
		const site = resolveSiteConfig('life');
		expect(site.id).toBe('life');
		expect(site.pillars).toHaveLength(9);
		for (const slug of site.pillars) {
			expect(PILLARS_BY_SLUG.has(slug), `pillar "${slug}" must be canonical`).toBe(true);
		}
		// life activates every canonical pillar exactly once
		expect(new Set(site.pillars).size).toBe(CANONICAL_PILLARS.length);
	});

	it('throws on an unknown SITE_ID', () => {
		expect(() => resolveSiteConfig('gibberish')).toThrow(/Unknown SITE_ID/);
	});

	it('throws on a missing SITE_ID', () => {
		expect(() => resolveSiteConfig(undefined)).toThrow(/SITE_ID is not set/);
		expect(() => resolveSiteConfig('')).toThrow(/SITE_ID is not set/);
	});
});

describe('canonical pillars', () => {
	it('defines 9 pillars with unique slugs and ro copy', () => {
		expect(CANONICAL_PILLARS).toHaveLength(9);
		expect(new Set(CANONICAL_PILLARS.map((p) => p.slug)).size).toBe(9);
		for (const p of CANONICAL_PILLARS) {
			expect(p.name).toBeTruthy();
			expect(p.description).toBeTruthy();
		}
	});
});
