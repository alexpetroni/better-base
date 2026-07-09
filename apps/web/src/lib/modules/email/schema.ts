import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Every email the platform attempts is recorded here — real sends AND dry
 * runs. The unique `idempotency_key` is the dedupe mechanism: `sendEmail`
 * claims the key by insert, so a retried handler can never send twice.
 */
export const emailLog = pgTable(
	'email_log',
	{
		id: text('id').primaryKey(),
		idempotencyKey: text('idempotency_key').notNull().unique(),
		toEmail: text('to_email').notNull(),
		template: text('template').notNull(),
		subject: text('subject').notNull(),
		data: jsonb('data').notNull().$type<Record<string, unknown>>(),
		// sending = claimed, delivery in flight; error rows may be retried.
		status: text('status', { enum: ['sending', 'sent', 'dryrun', 'error'] }).notNull(),
		providerId: text('provider_id'),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('email_log_to_email_idx').on(table.toEmail)]
);

export type EmailLogRow = typeof emailLog.$inferSelect;
export type EmailStatus = EmailLogRow['status'];
