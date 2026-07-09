import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Generic sliding-window counters for throttles that don't own a table of
 * their own (public email endpoints: keys `newsletter:ip:<addr>`,
 * `newsletter:global`, `quiz-email:ip:<addr>`, `quiz-email:global`).
 * Same column shape as login_attempts / chat_rate_limits — all three are
 * driven by the atomic upsert in ./core.ts.
 */
export const rateLimits = pgTable('rate_limits', {
	key: text('key').primaryKey(),
	count: integer('count').notNull(),
	prevCount: integer('prev_count').notNull().default(0),
	windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull()
});
