import { and, desc, eq, exists, inArray, ilike, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
	pillarSlugsFor,
	resolvePillarRows,
	setPillars,
	type PillarJoin
} from '../../db/pillar-tags.ts';
import { pillars, type Pillar } from '../../db/schema/core.ts';
import { ensureUniqueSlug, slugTaken } from '../../db/unique-slug.ts';
import type { Result } from '../../util/result.ts';
import { slugify } from '../../util/slug.ts';
import { media, type MediaRow } from '../media/schema.ts';
import { articlePillars, articles, type ArticleRow, type ArticleStatus } from './schema.ts';

/**
 * Blog service. Framework-free: the db is passed in so the same functions
 * serve routes, the seed script and integration tests. Pillar filtering is
 * the caller's responsibility to wire to the ACTIVE SITE's config —
 * `listPublished` only ever shows articles tagged to one of the given slugs.
 */

export interface BlogDeps {
	db: Db;
}

export type BlogError = 'not-found' | 'invalid-slug' | 'unknown-pillar' | 'invalid-title';

export type BlogResult<T> = Result<T, BlogError>;

export interface ArticleWithPillars {
	article: ArticleRow;
	pillarSlugs: string[];
	cover: MediaRow | null;
}

const ARTICLE_SLUGS = { table: articles, id: articles.id, slug: articles.slug };

const ARTICLE_PILLARS: PillarJoin<typeof articlePillars> = {
	table: articlePillars,
	parentId: articlePillars.articleId,
	pillarId: articlePillars.pillarId,
	link: (articleId, pillarId) => ({ articleId, pillarId })
};

/** Derive a free slug from a title (or explicit base), suffixing `-2`, `-3`, … on collision. */
function uniqueArticleSlug(db: Db, base: string, excludeId?: string): Promise<string> {
	return ensureUniqueSlug(db, ARTICLE_SLUGS, base, 'articol', excludeId);
}

export async function createArticle(
	deps: BlogDeps,
	input: { title: string; createdBy: string }
): Promise<BlogResult<ArticleRow>> {
	const title = input.title.trim();
	if (!title) return { ok: false, error: 'invalid-title' };
	const slug = await uniqueArticleSlug(deps.db, title);
	const [row] = await deps.db
		.insert(articles)
		.values({ id: crypto.randomUUID(), slug, title, createdBy: input.createdBy })
		.returning();
	return { ok: true, value: row };
}

export interface ArticlePatch {
	title?: string;
	slug?: string;
	excerpt?: string;
	bodyMd?: string;
	coverMediaId?: string | null;
	seoTitle?: string | null;
	seoDescription?: string | null;
	pillarSlugs?: string[];
}

export async function updateArticle(
	deps: BlogDeps,
	id: string,
	patch: ArticlePatch
): Promise<BlogResult<ArticleRow>> {
	const existing = await deps.db.select().from(articles).where(eq(articles.id, id));
	if (existing.length === 0) return { ok: false, error: 'not-found' };

	const set: Partial<typeof articles.$inferInsert> = { updatedAt: new Date() };
	if (patch.title !== undefined) {
		const title = patch.title.trim();
		if (!title) return { ok: false, error: 'invalid-title' };
		set.title = title;
	}
	if (patch.slug !== undefined) {
		const normalized = slugify(patch.slug);
		if (!normalized) return { ok: false, error: 'invalid-slug' };
		if (await slugTaken(deps.db, ARTICLE_SLUGS, normalized, id)) {
			set.slug = await uniqueArticleSlug(deps.db, normalized, id);
		} else {
			set.slug = normalized;
		}
	}
	if (patch.excerpt !== undefined) set.excerpt = patch.excerpt;
	if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd;
	if (patch.coverMediaId !== undefined) set.coverMediaId = patch.coverMediaId;
	if (patch.seoTitle !== undefined) set.seoTitle = patch.seoTitle || null;
	if (patch.seoDescription !== undefined) set.seoDescription = patch.seoDescription || null;

	let pillarRows: Pillar[] | null = null;
	if (patch.pillarSlugs !== undefined) {
		const resolved = await resolvePillarRows(deps.db, patch.pillarSlugs);
		if (!resolved.ok) {
			return { ok: false, error: 'unknown-pillar', detail: resolved.missing.join(', ') };
		}
		pillarRows = resolved.rows;
	}

	// Retag + row update commit together: a failure between the join-table
	// delete and re-insert must not strip the article's tags — that would
	// silently hide it from every site.
	const row = await deps.db.transaction(async (tx) => {
		if (pillarRows !== null) await setPillars(tx, ARTICLE_PILLARS, id, pillarRows);
		const [updated] = await tx.update(articles).set(set).where(eq(articles.id, id)).returning();
		return updated;
	});
	return { ok: true, value: row };
}

/** Publish: first publish stamps `publishedAt`; republishing keeps the original date. */
export async function publishArticle(deps: BlogDeps, id: string): Promise<BlogResult<ArticleRow>> {
	const [row] = await deps.db
		.update(articles)
		.set({
			status: 'published',
			publishedAt: sql`coalesce(${articles.publishedAt}, now())`,
			updatedAt: new Date()
		})
		.where(eq(articles.id, id))
		.returning();
	return row ? { ok: true, value: row } : { ok: false, error: 'not-found' };
}

export async function unpublishArticle(
	deps: BlogDeps,
	id: string
): Promise<BlogResult<ArticleRow>> {
	const [row] = await deps.db
		.update(articles)
		.set({ status: 'draft', updatedAt: new Date() })
		.where(eq(articles.id, id))
		.returning();
	return row ? { ok: true, value: row } : { ok: false, error: 'not-found' };
}

async function coverFor(db: Db, article: ArticleRow): Promise<MediaRow | null> {
	if (!article.coverMediaId) return null;
	const [row] = await db.select().from(media).where(eq(media.id, article.coverMediaId));
	return row ?? null;
}

export async function getArticle(deps: BlogDeps, id: string): Promise<ArticleWithPillars | null> {
	const [article] = await deps.db.select().from(articles).where(eq(articles.id, id));
	if (!article) return null;
	return {
		article,
		pillarSlugs: await pillarSlugsFor(deps.db, ARTICLE_PILLARS, id),
		cover: await coverFor(deps.db, article)
	};
}

/** Fetch by slug. Public callers get published articles only (the default). */
export async function getBySlug(
	deps: BlogDeps,
	slug: string,
	opts: { includeDrafts?: boolean } = {}
): Promise<ArticleWithPillars | null> {
	const [article] = await deps.db.select().from(articles).where(eq(articles.slug, slug));
	if (!article) return null;
	if (article.status !== 'published' && !opts.includeDrafts) return null;
	return {
		article,
		pillarSlugs: await pillarSlugsFor(deps.db, ARTICLE_PILLARS, article.id),
		cover: await coverFor(deps.db, article)
	};
}

export interface PublishedList {
	items: Array<{ article: ArticleRow; cover: MediaRow | null }>;
	total: number;
	page: number;
	pageSize: number;
	pageCount: number;
}

export const DEFAULT_PAGE_SIZE = 9;

/**
 * Published articles visible on a site: tagged to at least one of the given
 * pillar slugs (the active site's pillars from config). An article tagged to
 * no active pillar is invisible; an empty slug list shows nothing.
 */
export async function listPublished(
	deps: BlogDeps,
	opts: { pillarSlugs: string[]; page?: number; pageSize?: number }
): Promise<PublishedList> {
	const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
	const page = Math.max(1, opts.page ?? 1);
	if (opts.pillarSlugs.length === 0) {
		return { items: [], total: 0, page, pageSize, pageCount: 0 };
	}

	const taggedToActivePillar = exists(
		deps.db
			.select({ one: sql`1` })
			.from(articlePillars)
			.innerJoin(pillars, eq(articlePillars.pillarId, pillars.id))
			.where(
				and(eq(articlePillars.articleId, articles.id), inArray(pillars.slug, opts.pillarSlugs))
			)
	);
	const visible = and(eq(articles.status, 'published'), taggedToActivePillar);

	const [{ total }] = await deps.db
		.select({ total: sql<number>`count(*)::int` })
		.from(articles)
		.where(visible);

	const rows = await deps.db
		.select({ article: articles, cover: media })
		.from(articles)
		.leftJoin(media, eq(articles.coverMediaId, media.id))
		.where(visible)
		.orderBy(desc(articles.publishedAt), desc(articles.id))
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	return {
		items: rows,
		total,
		page,
		pageSize,
		pageCount: Math.ceil(total / pageSize)
	};
}

/** Admin listing: optional status filter and case-insensitive title/slug search. */
export async function listArticles(
	deps: BlogDeps,
	opts: { status?: ArticleStatus; search?: string } = {}
): Promise<ArticleRow[]> {
	const conditions = [];
	if (opts.status) conditions.push(eq(articles.status, opts.status));
	if (opts.search?.trim()) {
		const term = `%${opts.search.trim()}%`;
		conditions.push(or(ilike(articles.title, term), ilike(articles.slug, term)));
	}
	return deps.db
		.select()
		.from(articles)
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(articles.updatedAt), desc(articles.id));
}

/** All published slugs + dates, for sitemap.xml (site-visible ones only). */
export async function listPublishedForSitemap(
	deps: BlogDeps,
	pillarSlugs: string[]
): Promise<Array<{ slug: string; updatedAt: Date }>> {
	const all = await listPublished(deps, { pillarSlugs, page: 1, pageSize: 5000 });
	return all.items.map(({ article }) => ({ slug: article.slug, updatedAt: article.updatedAt }));
}
