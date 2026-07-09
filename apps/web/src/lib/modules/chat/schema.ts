import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Anonymous chat sessions. Ownership is proven by a signed cookie token that
 * carries (session id, anonymous_token) — see `token.ts`. Retention: sessions
 * older than 30 days are deleted by `pnpm chat:prune` (messages cascade).
 */
export const chatSessions = pgTable(
	'chat_sessions',
	{
		id: text('id').primaryKey(),
		anonymousToken: text('anonymous_token').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		/** Total messages stored for this session (user + assistant). */
		messageCount: integer('message_count').notNull().default(0)
	},
	(table) => [index('chat_sessions_created_at_idx').on(table.createdAt)]
);

export const chatMessages = pgTable(
	'chat_messages',
	{
		id: text('id').primaryKey(),
		sessionId: text('session_id')
			.notNull()
			.references(() => chatSessions.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['user', 'assistant'] }).notNull(),
		content: text('content').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('chat_messages_session_id_idx').on(table.sessionId, table.createdAt)]
);

/**
 * Fixed-window rate-limit counters, keyed `session:<id>` / `ip:<addr>` —
 * same pattern as auth's login_attempts.
 */
export const chatRateLimits = pgTable('chat_rate_limits', {
	key: text('key').primaryKey(),
	count: integer('count').notNull(),
	windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull()
});

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
