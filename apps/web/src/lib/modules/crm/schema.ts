import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Consents } from './consent.ts';

/**
 * Newsletter/lead subscribers. One row per email; consents are jsonb records
 * ({ granted, at, source } per key) so every change is timestamped and
 * attributable. `confirmed_at` is the double opt-in stamp — a subscriber is
 * mailable for the newsletter only with granted consent AND confirmation.
 */
export const subscribers = pgTable(
	'subscribers',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull().unique(),
		name: text('name'),
		locale: text('locale').notNull().default('ro'),
		consents: jsonb('consents').notNull().$type<Consents>().default({}),
		confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
		unsubscribeToken: text('unsubscribe_token').notNull().unique(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// The service normalizes to lowercase, but uniqueness must not depend on
		// every writer remembering to — `A@x.com` and `a@x.com` are one subscriber.
		uniqueIndex('subscribers_email_lower_uq').on(sql`lower(${table.email})`)
	]
);

export type SubscriberRow = typeof subscribers.$inferSelect;
