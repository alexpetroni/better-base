import type { RateLimitConfig } from '../../server/rate-limit/core.ts';

/**
 * 20 user messages per sliding hour, per session AND per IP. Counters are
 * consumed atomically via the shared core ($lib/server/rate-limit) against
 * the chat_rate_limits table — see service.ts.
 */
export const CHAT_RATE_LIMIT: RateLimitConfig = { max: 20, windowMs: 60 * 60 * 1000 };

export function sessionRateKey(sessionId: string): string {
	return `session:${sessionId}`;
}

export function ipRateKey(ip: string): string {
	return `ip:${ip}`;
}
