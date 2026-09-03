import { sql } from 'drizzle-orm';
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
		/** Metadata of attached files (never the bytes — those live in S3). */
		attachments: jsonb('attachments').$type<EmailAttachmentMeta[]>(),
		// sending = claimed, delivery in flight; error rows may be retried.
		status: text('status', { enum: ['sending', 'sent', 'dryrun', 'error'] }).notNull(),
		providerId: text('provider_id'),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('email_log_to_email_idx').on(table.toEmail),
		// GDPR erase matches on lower(to_email) — see modules/gdpr/erase.ts.
		index('email_log_to_email_lower_idx').on(sql`lower(${table.toEmail})`)
	]
);

export interface EmailAttachmentMeta {
	filename: string;
	contentType: string;
	size: number;
}

export type EmailLogRow = typeof emailLog.$inferSelect;
export type EmailStatus = EmailLogRow['status'];
