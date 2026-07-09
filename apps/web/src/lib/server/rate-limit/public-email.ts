import type { Db } from '../../db/client.ts';
import { consumeRateLimit, type RateLimitConfig } from './core.ts';
import { rateLimits } from './schema.ts';

/**
 * Throttle for public endpoints that send email to a visitor-supplied address
 * (newsletter signup, quiz-result email). Two caps per scope, both enforced
 * server-side before any send:
 *  - per IP: one visitor can only trigger a handful of sends per hour;
 *  - global: distinct victims from many IPs can't be mailbombed — the whole
 *    endpoint stops sending when the hourly budget is spent (a deliberate
 *    availability trade-off vs. burning email reputation/quota).
 *
 * If abuse ever outgrows these caps, add a CAPTCHA/proof-of-work check in the
 * two actions right before `consumePublicEmailBudget` — this is the hook
 * point; nothing is wired today by design.
 */
export const PUBLIC_EMAIL_IP_LIMIT: RateLimitConfig = { max: 10, windowMs: 60 * 60 * 1000 };
export const PUBLIC_EMAIL_GLOBAL_LIMIT: RateLimitConfig = { max: 200, windowMs: 60 * 60 * 1000 };

export type PublicEmailScope = 'newsletter' | 'quiz-email';

export interface PublicEmailLimits {
	ip: RateLimitConfig;
	global: RateLimitConfig;
}

const DEFAULT_LIMITS: PublicEmailLimits = {
	ip: PUBLIC_EMAIL_IP_LIMIT,
	global: PUBLIC_EMAIL_GLOBAL_LIMIT
};

/** Atomically consume one send slot; refuse when either cap is exhausted. */
export async function consumePublicEmailBudget(
	db: Db,
	scope: PublicEmailScope,
	ip: string,
	now: Date = new Date(),
	limits: PublicEmailLimits = DEFAULT_LIMITS
): Promise<{ limited: boolean }> {
	const [byIp, global] = await Promise.all([
		consumeRateLimit(db, rateLimits, `${scope}:ip:${ip}`, limits.ip, now),
		consumeRateLimit(db, rateLimits, `${scope}:global`, limits.global, now)
	]);
	return { limited: byIp.limited || global.limited };
}
