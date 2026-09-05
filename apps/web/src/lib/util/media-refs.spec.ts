import { describe, expect, it } from 'vitest';
import { extractMediaRefs, mediaRefPattern } from './media-refs.ts';

describe('extractMediaRefs', () => {
	it('collects id and key refs, with or without a title', () => {
		expect(
			extractMediaRefs('![a](media:abc) ![b](media:uploads/x/y.png "Titlu") ![c](media:abc)')
		).toEqual(['abc', 'uploads/x/y.png']);
	});
});

// FIX-15 (audit P2 'media-ref matching misses titled refs'): the delete
// guard used `LIKE '%(media:ID)%'`, which a title segment defeats —
// `![a](media:ID "title")` — so the library would delete an image an
// article still embeds.
describe('mediaRefPattern', () => {
	const matches = (ref: string, md: string) => new RegExp(mediaRefPattern(ref)).test(md);

	it('matches plain and titled refs', () => {
		expect(matches('abc', '![a](media:abc)')).toBe(true);
		expect(matches('abc', '![a](media:abc "Titlu")')).toBe(true);
		expect(matches('abc', "![a](media:abc\t'Titlu')")).toBe(true);
	});

	it('does not match a ref that merely starts with the id', () => {
		expect(matches('abc', '![a](media:abcd)')).toBe(false);
		expect(matches('abc', '![a](media:abc-2 "t")')).toBe(false);
	});

	it('escapes regex metacharacters in storage keys', () => {
		expect(matches('uploads/x/a.png', '![a](media:uploads/x/a.png)')).toBe(true);
		expect(matches('uploads/x/a.png', '![a](media:uploads/x/aXpng)')).toBe(false);
	});
});
