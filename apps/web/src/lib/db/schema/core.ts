import { integer, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * Pillars active on this site, seeded from the site config (`pnpm db:seed`).
 * Content tables (articles, products, quizzes) join to this in later phases.
 */
export const pillars = pgTable('pillars', {
	id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
	slug: text('slug').notNull().unique(),
	name: text('name').notNull(),
	description: text('description'),
	sort: integer('sort').notNull().default(0)
});

export type Pillar = typeof pillars.$inferSelect;
