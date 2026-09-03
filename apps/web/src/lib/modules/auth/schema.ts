import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

/**
 * Staff users (better-auth "user" model, plural table names via `usePlural`).
 * Public signup is disabled; rows are created only by the user:create CLI or
 * (in later phases) by an admin. `role` is a better-auth additionalField.
 */
export const users = pgTable(
	'users',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		email: text('email').notNull().unique(),
		emailVerified: boolean('emailVerified').notNull().default(false),
		image: text('image'),
		role: text('role', { enum: ['admin', 'editor'] })
			.notNull()
			.default('editor'),
		createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// better-auth lowercases emails, but a bypassing writer (CLI, script)
		// must not be able to create `A@x.com` next to `a@x.com`.
		uniqueIndex('users_email_lower_uq').on(sql`lower(${table.email})`)
	]
);

export const sessions = pgTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
		token: text('token').notNull().unique(),
		createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
		ipAddress: text('ipAddress'),
		userAgent: text('userAgent'),
		userId: text('userId')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' })
	},
	(table) => [index('sessions_userId_idx').on(table.userId)]
);

export const accounts = pgTable(
	'accounts',
	{
		id: text('id').primaryKey(),
		accountId: text('accountId').notNull(),
		providerId: text('providerId').notNull(),
		userId: text('userId')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		accessToken: text('accessToken'),
		refreshToken: text('refreshToken'),
		idToken: text('idToken'),
		accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
		refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
		scope: text('scope'),
		password: text('password'),
		createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('accounts_userId_idx').on(table.userId)]
);

export const verifications = pgTable(
	'verifications',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
		createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('verifications_identifier_idx').on(table.identifier)]
);

/**
 * Sliding-window login rate limiting, keyed by IP + email (see rate-limit.ts,
 * counter shape from $lib/server/rate-limit). Not a better-auth table.
 */
export const loginAttempts = pgTable('login_attempts', {
	id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
	key: text('key').notNull().unique(),
	count: integer('count').notNull(),
	prevCount: integer('prev_count').notNull().default(0),
	windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull()
});

/**
 * Append-only staff action log (audit 2026-09-03, login hardening): who
 * logged in, exported PII, deleted media, toggled nurture, rewrote a legal
 * page. Append-only is enforced by DB triggers (migration 0020) like the
 * fiscal tables — an admin session cannot cover its own tracks.
 */
export const adminAudit = pgTable(
	'admin_audit',
	{
		id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
		/** Staff email — stable even if the user row is later deleted. */
		actor: text('actor').notNull(),
		action: text('action').notNull(),
		/** What was acted on (row id, export month, …); '' when self-evident. */
		target: text('target').notNull().default(''),
		at: timestamp('at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('admin_audit_at_idx').on(table.at)]
);

export type StaffUser = typeof users.$inferSelect;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type AdminAuditRow = typeof adminAudit.$inferSelect;
