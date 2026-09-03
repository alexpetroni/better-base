import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
	consumeRateLimit,
	type RateLimitConfig,
	type RateLimitResult
} from '../../server/rate-limit/core.ts';
import { loginAttempts } from './schema.ts';

/**
 * 5 login attempts per sliding 15-minute window per IP+email. Attempts are
 * counted atomically BEFORE the password check (a successful login clears the
 * counter), so a concurrent burst cannot bypass the cap — see
 * $lib/server/rate-limit for the shared sliding-window core.
 */
export const LOGIN_RATE_LIMIT: RateLimitConfig = { max: 5, windowMs: 15 * 60 * 1000 };

/**
 * Second counter, keyed by EMAIL ALONE (20 attempts per sliding hour): an
 * attacker rotating IPs never trips the per-IP counter, so this one bounds
 * the damage per ACCOUNT (audit 2026-09-03, login hardening). Loose enough
 * that a typo-prone staff member is not locked out by the tighter IP window.
 */
export const EMAIL_LOGIN_RATE_LIMIT: RateLimitConfig = { max: 20, windowMs: 60 * 60 * 1000 };

export function rateLimitKey(ip: string, email: string): string {
	return `${ip}:${email.trim().toLowerCase()}`;
}

/** `email:` prefix keeps the two counter families apart in login_attempts. */
export function emailRateLimitKey(email: string): string {
	return `email:${email.trim().toLowerCase()}`;
}

/** Atomically count this attempt; the cap decision comes from the returned count. */
export async function registerLoginAttempt(
	db: Db,
	key: string,
	now: Date = new Date()
): Promise<RateLimitResult> {
	return consumeRateLimit(db, loginAttempts, key, LOGIN_RATE_LIMIT, now);
}

/** The email-only counter's version of `registerLoginAttempt`. */
export async function registerEmailLoginAttempt(
	db: Db,
	key: string,
	now: Date = new Date()
): Promise<RateLimitResult> {
	return consumeRateLimit(db, loginAttempts, key, EMAIL_LOGIN_RATE_LIMIT, now);
}

export async function clearAttempts(db: Db, key: string): Promise<void> {
	await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}
