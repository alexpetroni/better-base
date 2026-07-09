import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.ts';

/**
 * Shared rate-limit core (framework-free). Counters live in a Postgres table
 * with the fixed column shape (key, count, prev_count, window_started_at) —
 * login_attempts, chat_rate_limits and the generic rate_limits all match.
 *
 * The counter is a "sliding window counter": requests increment the count of
 * the current ALIGNED fixed window; the previous window's total decays
 * linearly as the current window progresses. This closes the classic
 * fixed-window boundary burst (max-at-end + max-at-start ≈ 2×max in minutes).
 *
 * The increment is a single atomic upsert — window rollover is decided in SQL
 * against the stored window_started_at, and the cap decision is made from the
 * RETURNING values, never from a separate read. Concurrent requests therefore
 * cannot lose increments or over-admit past the in-flight burst.
 */
export interface RateLimitConfig {
	/** Requests admitted per window (the (max+1)-th is refused). */
	max: number;
	windowMs: number;
}

export interface RateLimitCounters {
	/** Post-increment count of the current window. */
	count: number;
	/** Total of the immediately preceding window (0 after a gap ≥ 2 windows). */
	prevCount: number;
}

export interface RateLimitResult extends RateLimitCounters {
	limited: boolean;
}

/** Start of the aligned fixed window containing `now`. */
export function windowStart(now: Date, windowMs: number): Date {
	return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Sliding-window estimate of "requests in the last window": the previous
 * window's count weighted by how much of it still overlaps the sliding span.
 */
export function weightedCount(
	counters: RateLimitCounters,
	config: RateLimitConfig,
	now: Date
): number {
	const elapsed = (now.getTime() - windowStart(now, config.windowMs).getTime()) / config.windowMs;
	return counters.count + counters.prevCount * (1 - elapsed);
}

/** Cap decision from post-increment counters — request N is admitted while N ≤ max. */
export function isLimited(
	counters: RateLimitCounters,
	config: RateLimitConfig,
	now: Date
): boolean {
	return weightedCount(counters, config, now) > config.max;
}

/**
 * Atomically consume one slot for `key`: increment (with in-SQL window
 * rollover) and decide from the returned post-increment counters.
 *
 * Refused requests still consume a slot, so hammering a limited key keeps it
 * limited — the counter never loses increments under concurrency.
 */
export async function consumeRateLimit(
	db: Db,
	table: PgTable,
	key: string,
	config: RateLimitConfig,
	now: Date = new Date()
): Promise<RateLimitResult> {
	const current = windowStart(now, config.windowMs);
	const previous = new Date(current.getTime() - config.windowMs);
	const result = await db.execute(sql`
		insert into ${table} (key, count, prev_count, window_started_at)
		values (${key}, 1, 0, ${current})
		on conflict (key) do update set
			count = case
				when ${table}.window_started_at >= ${current} then ${table}.count + 1
				else 1
			end,
			prev_count = case
				when ${table}.window_started_at >= ${current} then ${table}.prev_count
				when ${table}.window_started_at >= ${previous} then ${table}.count
				else 0
			end,
			window_started_at = case
				when ${table}.window_started_at >= ${current} then ${table}.window_started_at
				else ${current}
			end
		returning count, prev_count
	`);
	const row = result.rows[0] as { count: number; prev_count: number };
	const counters = { count: Number(row.count), prevCount: Number(row.prev_count) };
	return { ...counters, limited: isLimited(counters, config, now) };
}

/**
 * Delete counter rows whose window started before `cutoff`. Counters are
 * upserted per key and never deleted by `consumeRateLimit`, so every table
 * with this shape (rate_limits, chat_rate_limits, login_attempts) grows with
 * each new key forever unless a retention job sweeps it. A row untouched for
 * two windows already weighs nothing in the sliding-window decision — any
 * cutoff at least that old is safe.
 */
export async function pruneStaleRateLimits(db: Db, table: PgTable, cutoff: Date): Promise<number> {
	const result = await db.execute(sql`delete from ${table} where window_started_at < ${cutoff}`);
	return result.rowCount ?? 0;
}
