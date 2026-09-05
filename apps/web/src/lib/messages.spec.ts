import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Message catalog parity: the sites ship `ro` only (FIX-15 locale policy), but
// `en.json` stays as the second catalog paraglide compiles — every key must
// exist in both, or a future `en` rollout starts with silent fallbacks.
function keysOf(locale: string): string[] {
	const file = path.resolve(import.meta.dirname, `../../messages/${locale}.json`);
	return Object.keys(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
		.filter((k) => k !== '$schema')
		.sort();
}

describe('messages/*.json', () => {
	it('ro and en carry the same keys', () => {
		const ro = keysOf('ro');
		const en = keysOf('en');
		expect(en.filter((k) => !ro.includes(k))).toEqual([]);
		expect(ro.filter((k) => !en.includes(k))).toEqual([]);
		expect(ro.length).toBeGreaterThan(0);
	});
});
