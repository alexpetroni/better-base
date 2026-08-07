import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Processed-events ledger (audit L6, made load-bearing by NEXT-5): one row per
 * external provider event whose effect must run at most once. The row is
 * claimed by insert INSIDE the same transaction as the effect it guards
 * (`runOnce` in core.ts), so a redelivered event of ANY type is detected and
 * acknowledged without repeating the effect — and a failed effect rolls the
 * claim back, so a poisoned event can be retried.
 *
 * Order-independent by design: invoice issuance, shipping notifications and
 * any future webhook/cron effect key on the same table.
 */
export const processedEvents = pgTable(
	'processed_events',
	{
		/** Event source, e.g. `stripe`. Part of the key so ids cannot collide across providers. */
		provider: text('provider').notNull(),
		/** The provider's own event id (e.g. `evt_…`) — the idempotency anchor. */
		eventId: text('event_id').notNull(),
		eventType: text('event_type').notNull(),
		/**
		 * What the first delivery did (e.g. `order-created`, `refund-unmatched`),
		 * recorded when the effect commits — so the admin can see why a
		 * redelivered event did nothing.
		 */
		outcome: text('outcome').notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		primaryKey({ columns: [table.provider, table.eventId] }),
		// The retention sweep deletes by age.
		index('processed_events_received_at_idx').on(table.receivedAt)
	]
);

export type ProcessedEventRow = typeof processedEvents.$inferSelect;
