import { describe, expect, it } from 'vitest';
import { isLimited, weightedCount, windowStart, type RateLimitConfig } from './core.ts';

const CONFIG: RateLimitConfig = { max: 5, windowMs: 15 * 60 * 1000 };
// Aligned window boundary (multiple of windowMs), so offsets are exact.
const W0 = new Date(
	Math.ceil(new Date('2026-01-01T12:00:00Z').getTime() / CONFIG.windowMs) * CONFIG.windowMs
);
const at = (ms: number) => new Date(W0.getTime() + ms);

describe('windowStart', () => {
	it('floors to the aligned window containing now', () => {
		expect(windowStart(W0, CONFIG.windowMs)).toEqual(W0);
		expect(windowStart(at(CONFIG.windowMs - 1), CONFIG.windowMs)).toEqual(W0);
		expect(windowStart(at(CONFIG.windowMs), CONFIG.windowMs)).toEqual(at(CONFIG.windowMs));
	});
});

describe('weightedCount / isLimited (sliding window)', () => {
	it('admits up to max and refuses the (max+1)-th from the returned count alone', () => {
		// Post-increment counts 1..5 pass, 6 is refused — no separate read.
		for (let count = 1; count <= CONFIG.max; count++) {
			expect(isLimited({ count, prevCount: 0 }, CONFIG, at(1000))).toBe(false);
		}
		expect(isLimited({ count: CONFIG.max + 1, prevCount: 0 }, CONFIG, at(1000))).toBe(true);
	});

	it('closes the fixed-window boundary burst: a full previous window still counts early in the next', () => {
		// max requests at the end of window 0; the first request just after the
		// boundary sees weighted ≈ 1 + max → refused (fixed window admitted it).
		const justAfter = at(CONFIG.windowMs + 1000);
		const counters = { count: 1, prevCount: CONFIG.max };
		expect(weightedCount(counters, CONFIG, justAfter)).toBeGreaterThan(CONFIG.max);
		expect(isLimited(counters, CONFIG, justAfter)).toBe(true);
	});

	it('decays the previous window linearly until requests are admitted again', () => {
		// At 40% into the next window: 1 + 5·0.6 = 4 ≤ 5 → admitted.
		const later = at(CONFIG.windowMs + 0.4 * CONFIG.windowMs);
		const counters = { count: 1, prevCount: CONFIG.max };
		expect(weightedCount(counters, CONFIG, later)).toBeCloseTo(4);
		expect(isLimited(counters, CONFIG, later)).toBe(false);
	});

	it('ignores the previous window entirely once the current window is over', () => {
		const endOfWindow = at(2 * CONFIG.windowMs - 1);
		expect(weightedCount({ count: 1, prevCount: 100 }, CONFIG, endOfWindow)).toBeCloseTo(1, 1);
	});
});
