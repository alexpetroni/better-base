import { describe, expect, it } from 'vitest';
import { nextUniqueSlug, slugify } from './slug.ts';

describe('slugify', () => {
	it('transliterates romanian diacritics (comma-below forms)', () => {
		expect(slugify('Știința somnului: învață să dormi')).toBe('stiinta-somnului-invata-sa-dormi');
	});

	it('transliterates the legacy cedilla forms ş/ţ', () => {
		expect(slugify('Şapte paşi către relaxare, fără reţete')).toBe(
			'sapte-pasi-catre-relaxare-fara-retete'
		);
	});

	it('handles ă/â/î', () => {
		expect(slugify('Cât de mult să dormi în fiecare noapte')).toBe(
			'cat-de-mult-sa-dormi-in-fiecare-noapte'
		);
	});

	it('lowercases, collapses punctuation runs and trims dashes', () => {
		expect(slugify('  Hello,   World!!! ')).toBe('hello-world');
		expect(slugify('--A -- B--')).toBe('a-b');
	});

	it('strips other latin diacritics via NFD', () => {
		expect(slugify('Café Zürich São')).toBe('cafe-zurich-sao');
	});

	it('returns empty string when nothing survives', () => {
		expect(slugify('!!! ???')).toBe('');
		expect(slugify('日本語')).toBe('');
	});

	it('caps length without ending in a dash', () => {
		const slug = slugify(`${'a'.repeat(95)} b`);
		expect(slug.length).toBeLessThanOrEqual(96);
		expect(slug.endsWith('-')).toBe(false);
	});
});

describe('nextUniqueSlug', () => {
	it('returns the base when free', () => {
		expect(nextUniqueSlug('somn', () => false)).toBe('somn');
	});

	it('suffixes -2, -3, … skipping taken candidates', () => {
		const taken = new Set(['somn', 'somn-2', 'somn-3']);
		expect(nextUniqueSlug('somn', (s) => taken.has(s))).toBe('somn-4');
	});

	it('falls back to "articol" for an empty base', () => {
		expect(nextUniqueSlug('', () => false)).toBe('articol');
		const taken = new Set(['articol']);
		expect(nextUniqueSlug('', (s) => taken.has(s))).toBe('articol-2');
	});
});
