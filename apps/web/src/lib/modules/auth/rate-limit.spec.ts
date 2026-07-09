import { describe, expect, it } from 'vitest';
import { rateLimitKey } from './rate-limit.ts';

// Window/cap behavior lives in the shared core — see
// src/lib/server/rate-limit/core.spec.ts (pure) and rate-limit.spec.ts (db),
// plus the racing regression in auth.spec.ts.
describe('rateLimitKey', () => {
	it('is case- and whitespace-insensitive on the email', () => {
		expect(rateLimitKey('1.2.3.4', ' Admin@Example.com ')).toBe('1.2.3.4:admin@example.com');
	});

	it('separates identical emails behind different IPs', () => {
		expect(rateLimitKey('1.2.3.4', 'a@b.ro')).not.toBe(rateLimitKey('5.6.7.8', 'a@b.ro'));
	});
});
