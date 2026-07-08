import { describe, expect, it } from 'vitest';
import {
	LOGIN_RATE_LIMIT,
	isRateLimited,
	rateLimitKey,
	recordFailure,
	type AttemptState
} from './rate-limit.ts';

const T0 = new Date('2026-01-01T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60 * 1000;

describe('rateLimitKey', () => {
	it('is case- and whitespace-insensitive on the email', () => {
		expect(rateLimitKey('1.2.3.4', ' Admin@Example.com ')).toBe('1.2.3.4:admin@example.com');
	});
});

describe('recordFailure / isRateLimited', () => {
	it('allows the first five failures and blocks the sixth within the window', () => {
		let state: AttemptState | null = null;
		for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT.maxAttempts; attempt++) {
			expect(isRateLimited(state, at(attempt * 1000))).toBe(false);
			state = recordFailure(state, at(attempt * 1000));
		}
		expect(state?.count).toBe(5);
		expect(isRateLimited(state, at(6 * 1000))).toBe(true);
		expect(isRateLimited(state, at(14 * MIN))).toBe(true);
	});

	it('unblocks once the 15-minute window has passed', () => {
		let state: AttemptState | null = null;
		for (let i = 0; i < 5; i++) state = recordFailure(state, T0);
		expect(isRateLimited(state, at(15 * MIN - 1))).toBe(true);
		expect(isRateLimited(state, at(15 * MIN))).toBe(false);
	});

	it('starts a fresh window when a failure lands after expiry', () => {
		let state: AttemptState | null = null;
		for (let i = 0; i < 5; i++) state = recordFailure(state, T0);
		const next = recordFailure(state, at(16 * MIN));
		expect(next).toEqual({ count: 1, windowStartedAt: at(16 * MIN) });
	});

	it('keeps the window anchor while failures accumulate inside it', () => {
		const first = recordFailure(null, T0);
		const second = recordFailure(first, at(5 * MIN));
		expect(second).toEqual({ count: 2, windowStartedAt: T0 });
	});

	it('treats no recorded state as not limited', () => {
		expect(isRateLimited(null, T0)).toBe(false);
	});
});
