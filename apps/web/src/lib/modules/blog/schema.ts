import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { pillars } from '../../db/schema/core.ts';
import { users } from '../auth/schema.ts';
import { media } from '../media/schema.ts';

/**
 * Blog articles: markdown bodies stored in the DB, rendered server-side.
 * Visibility on a site is decided by pillar tagging (`article_pillars`) —
 * public listings only show articles tagged to a pillar active in the site
 * config. There is no site column anywhere: each site has its own database.
 */
export const articles = pgTable(
	'articles',
	{
		id: text('id').primaryKey(),
		slug: text('slug').notNull().unique(),
		title: text('title').notNull(),
		excerpt: text('excerpt').notNull().default(''),
		bodyMd: text('body_md').notNull().default(''),
		coverMediaId: text('cover_media_id').references(() => media.id, { onDelete: 'set null' }),
		status: text('status', { enum: ['draft', 'published'] })
			.notNull()
			.default('draft'),
		publishedAt: timestamp('published_at', { withTimezone: true }),
		seoTitle: text('seo_title'),
		seoDescription: text('seo_description'),
		createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('articles_status_published_at_idx').on(table.status, table.publishedAt),
		index('articles_cover_media_id_idx').on(table.coverMediaId),
		index('articles_created_by_idx').on(table.createdBy)
	]
);

export const articlePillars = pgTable(
	'article_pillars',
	{
		articleId: text('article_id')
			.notNull()
			.references(() => articles.id, { onDelete: 'cascade' }),
		pillarId: integer('pillar_id')
			.notNull()
			.references(() => pillars.id, { onDelete: 'cascade' })
	},
	(table) => [
		primaryKey({ columns: [table.articleId, table.pillarId] }),
		index('article_pillars_pillar_id_idx').on(table.pillarId)
	]
);

export type ArticleRow = typeof articles.$inferSelect;
export type ArticleStatus = ArticleRow['status'];
