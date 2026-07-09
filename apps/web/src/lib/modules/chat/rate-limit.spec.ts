import { describe, expect, it } from 'vitest';
import {
	CHAT_RATE_LIMIT,
	ipRateKey,
	isChatRateLimited,
	recordChatMessage,
	sessionRateKey
} from './rate-limit.ts';

const T0 = new Date('2026-07-01T10:00:00Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe('chat rate limiting (pure)', () => {
	it('allows the first message and counts up to the limit', () => {
		let state = null as ReturnType<typeof recordChatMessage> | null;
		for (let i = 0; i < CHAT_RATE_LIMIT.maxMessages; i++) {
			expect(isChatRateLimited(state, T0)).toBe(false);
			state = recordChatMessage(state, T0);
		}
		expect(state?.count).toBe(20);
		// The 21st message inside the window is blocked.
		expect(isChatRateLimited(state, at(CHAT_RATE_LIMIT.windowMs - 1))).toBe(true);
	});

	it('unblocks when the window expires and restarts the counter', () => {
		let state = null as ReturnType<typeof recordChatMessage> | null;
		for (let i = 0; i < CHAT_RATE_LIMIT.maxMessages; i++) state = recordChatMessage(state, T0);

		const afterWindow = at(CHAT_RATE_LIMIT.windowMs);
		expect(isChatRateLimited(state, afterWindow)).toBe(false);
		const restarted = recordChatMessage(state, afterWindow);
		expect(restarted).toEqual({ count: 1, windowStartedAt: afterWindow });
	});

	it('keeps the window anchored at the first message of the window', () => {
		const first = recordChatMessage(null, T0);
		const second = recordChatMessage(first, at(1000));
		expect(second.windowStartedAt).toEqual(T0);
		expect(second.count).toBe(2);
	});

	it('namespaces session and ip keys', () => {
		expect(sessionRateKey('abc')).toBe('session:abc');
		expect(ipRateKey('1.2.3.4')).toBe('ip:1.2.3.4');
		expect(sessionRateKey('x')).not.toBe(ipRateKey('x'));
	});
});
