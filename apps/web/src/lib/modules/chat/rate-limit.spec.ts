import { describe, expect, it } from 'vitest';
import { CHAT_RATE_LIMIT, ipRateKey, sessionRateKey } from './rate-limit.ts';

// Window/cap behavior lives in the shared core — see
// src/lib/server/rate-limit/core.spec.ts (pure) and rate-limit.spec.ts (db),
// plus the racing regression in chat.spec.ts.
describe('chat rate-limit keys', () => {
	it('namespaces session and ip keys', () => {
		expect(sessionRateKey('abc')).toBe('session:abc');
		expect(ipRateKey('1.2.3.4')).toBe('ip:1.2.3.4');
		expect(sessionRateKey('x')).not.toBe(ipRateKey('x'));
	});

	it('keeps the documented budget: 20 messages per sliding hour', () => {
		expect(CHAT_RATE_LIMIT).toEqual({ max: 20, windowMs: 60 * 60 * 1000 });
	});
});
