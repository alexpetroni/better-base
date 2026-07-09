import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Simple DB-backed pages (privacy policy, terms, …): a slug, a title and a
 * markdown body, editable in /admin/pages and rendered at /pagini/[slug].
 * Deliberately minimal — no pillar tagging, no media refs, no drafts: these
 * are the legal/informational pages every site must serve from day one.
 */
export const pages = pgTable('pages', {
	id: text('id').primaryKey(),
	slug: text('slug').notNull().unique(),
	title: text('title').notNull(),
	bodyMd: text('body_md').notNull().default(''),
	seoDescription: text('seo_description'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export type PageRow = typeof pages.$inferSelect;
