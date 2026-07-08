import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { loginAttempts } from './schema.ts';

/** 5 failed attempts per IP+email open a 15-minute block window. */
export const LOGIN_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 } as const;

export interface RateLimitConfig {
	maxAttempts: number;
	windowMs: number;
}

export interface AttemptState {
	count: number;
	windowStartedAt: Date;
}

export function rateLimitKey(ip: string, email: string): string {
	return `${ip}:${email.trim().toLowerCase()}`;
}

/** Pure: is a new attempt blocked given the recorded failure state? */
export function isRateLimited(
	state: AttemptState | null,
	now: Date,
	config: RateLimitConfig = LOGIN_RATE_LIMIT
): boolean {
	if (!state) return false;
	if (now.getTime() - state.windowStartedAt.getTime() >= config.windowMs) return false;
	return state.count >= config.maxAttempts;
}

/** Pure: next state after a failed attempt (fixed window, resets on expiry). */
export function recordFailure(
	state: AttemptState | null,
	now: Date,
	config: RateLimitConfig = LOGIN_RATE_LIMIT
): AttemptState {
	if (!state || now.getTime() - state.windowStartedAt.getTime() >= config.windowMs) {
		return { count: 1, windowStartedAt: now };
	}
	return { count: state.count + 1, windowStartedAt: state.windowStartedAt };
}

export async function getAttemptState(db: Db, key: string): Promise<AttemptState | null> {
	const [row] = await db
		.select({ count: loginAttempts.count, windowStartedAt: loginAttempts.windowStartedAt })
		.from(loginAttempts)
		.where(eq(loginAttempts.key, key));
	return row ?? null;
}

export async function saveAttemptState(db: Db, key: string, state: AttemptState): Promise<void> {
	await db
		.insert(loginAttempts)
		.values({ key, count: state.count, windowStartedAt: state.windowStartedAt })
		.onConflictDoUpdate({
			target: loginAttempts.key,
			set: { count: state.count, windowStartedAt: state.windowStartedAt }
		});
}

export async function clearAttempts(db: Db, key: string): Promise<void> {
	await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}
