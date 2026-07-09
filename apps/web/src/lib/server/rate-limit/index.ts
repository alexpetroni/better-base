// Shared rate-limit core: atomic sliding-window counters (see core.ts).
// Framework-free — scripts and vitest import these files directly too.
export {
	consumeRateLimit,
	isLimited,
	weightedCount,
	windowStart,
	type RateLimitConfig,
	type RateLimitCounters,
	type RateLimitResult
} from './core.ts';
export {
	consumePublicEmailBudget,
	PUBLIC_EMAIL_GLOBAL_LIMIT,
	PUBLIC_EMAIL_IP_LIMIT,
	type PublicEmailLimits,
	type PublicEmailScope
} from './public-email.ts';
export { rateLimits } from './schema.ts';
