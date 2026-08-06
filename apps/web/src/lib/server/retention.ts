// The retention sweep: one job, two callers. `pnpm chat:prune` runs it from
// cron on a VPS; `/api/cron/chat-prune` runs it on Vercel, where there is no
// machine to run scripts on. Keeping the orchestration here means the two can
// never drift apart.
//
// Framework-free and node-safe (no $env/$app imports), so the plain-node
// script can import it directly.
import type { Db } from '../db/client.ts';
import { loginAttempts } from '../modules/auth/schema.ts';
import { CHAT_RETENTION_DAYS, pruneChatSessions } from '../modules/chat/service.ts';
import { pruneStaleRateLimits } from './rate-limit/core.ts';
import { rateLimits } from './rate-limit/schema.ts';

export interface RetentionSweepResult {
	/** Chat sessions deleted (messages cascade). */
	sessions: number;
	/** Rate-limit counter rows deleted, per table. */
	chatRateLimitRows: number;
	publicEmailRateLimitRows: number;
	loginRateLimitRows: number;
	retentionDays: number;
}

/**
 * Delete chat sessions older than the retention window and sweep expired
 * rate-limit counters. The limiter upserts one row per key (`ip:`, `session:`,
 * `newsletter:ip:`, …) and never deletes, so without this the counter tables
 * grow unbounded (audit resilience #6).
 *
 * The counters' windows are minutes-to-an-hour, so the same 30-day cutoff is
 * far past any row that still influences a decision.
 */
export async function runRetentionSweep(
	db: Db,
	now: Date = new Date()
): Promise<RetentionSweepResult> {
	const cutoff = new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const chat = await pruneChatSessions(db, now);
	return {
		sessions: chat.sessions,
		chatRateLimitRows: chat.rateLimitRows,
		publicEmailRateLimitRows: await pruneStaleRateLimits(db, rateLimits, cutoff),
		loginRateLimitRows: await pruneStaleRateLimits(db, loginAttempts, cutoff),
		retentionDays: CHAT_RETENTION_DAYS
	};
}

/** One-line summary for CLI output and structured logs. */
export function formatRetentionSweep(r: RetentionSweepResult): string {
	return (
		`retention sweep — deleted ${r.sessions} session(s) older than ${r.retentionDays} days, ` +
		`${r.chatRateLimitRows} chat / ${r.publicEmailRateLimitRows} public-email / ` +
		`${r.loginRateLimitRows} login rate-limit row(s)`
	);
}
