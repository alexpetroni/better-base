import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from '../auth/schema.ts';
import type { SettingJsonValue } from './registry.ts';

/**
 * Operator-editable site settings: ONE key/value row per setting, so later
 * phases add settings without a migration. The known keys, their validators
 * and defaults live in `registry.ts` — this table stores only what the
 * operator explicitly saved. No `site_id` column: one database per site is a
 * binding invariant of the platform.
 */
export const siteSettings = pgTable('site_settings', {
	key: text('key').primaryKey(),
	value: jsonb('value').notNull().$type<SettingJsonValue>(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	// Audit trail: who saved last. Seeded placeholder rows have no author.
	updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' })
});

export type SiteSettingRow = typeof siteSettings.$inferSelect;
