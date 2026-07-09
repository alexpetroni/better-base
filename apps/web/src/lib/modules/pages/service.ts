import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { nextUniqueSlug, slugify } from '../blog/slug.ts';
import { pages, type PageRow } from './schema.ts';

export interface PagesDeps {
	db: Db;
}

export type PagesResult<T> =
	{ ok: true; value: T } | { ok: false; error: 'not-found' | 'invalid-title' };

export async function getPageBySlug(deps: PagesDeps, slug: string): Promise<PageRow | null> {
	const [row] = await deps.db.select().from(pages).where(eq(pages.slug, slug));
	return row ?? null;
}

export async function getPage(deps: PagesDeps, id: string): Promise<PageRow | null> {
	const [row] = await deps.db.select().from(pages).where(eq(pages.id, id));
	return row ?? null;
}

export async function listPages(deps: PagesDeps): Promise<PageRow[]> {
	return deps.db.select().from(pages).orderBy(asc(pages.title));
}

/** Create a page with a unique slug derived from the title. */
export async function createPage(
	deps: PagesDeps,
	input: { title: string }
): Promise<PagesResult<PageRow>> {
	const title = input.title.trim();
	if (!title) return { ok: false, error: 'invalid-title' };
	const base = slugify(title);
	if (!base) return { ok: false, error: 'invalid-title' };
	const existing = new Set(
		(await deps.db.select({ slug: pages.slug }).from(pages)).map((r) => r.slug)
	);
	const slug = nextUniqueSlug(base, (candidate) => existing.has(candidate));
	const [row] = await deps.db
		.insert(pages)
		.values({ id: crypto.randomUUID(), slug, title })
		.returning();
	return { ok: true, value: row };
}

export async function updatePage(
	deps: PagesDeps,
	id: string,
	patch: { title: string; bodyMd: string; seoDescription: string | null }
): Promise<PagesResult<PageRow>> {
	if (!patch.title.trim()) return { ok: false, error: 'invalid-title' };
	const [row] = await deps.db
		.update(pages)
		.set({
			title: patch.title.trim(),
			bodyMd: patch.bodyMd,
			seoDescription: patch.seoDescription,
			updatedAt: new Date()
		})
		.where(eq(pages.id, id))
		.returning();
	if (!row) return { ok: false, error: 'not-found' };
	return { ok: true, value: row };
}

/**
 * Seed helper: create a page ONLY if its slug does not exist yet. Never
 * overwrites — re-seeding must not clobber legal copy edited in the admin.
 */
export async function ensurePage(
	deps: PagesDeps,
	input: { id: string; slug: string; title: string; bodyMd: string; seoDescription?: string }
): Promise<'created' | 'exists'> {
	const inserted = await deps.db
		.insert(pages)
		.values({
			id: input.id,
			slug: input.slug,
			title: input.title,
			bodyMd: input.bodyMd,
			seoDescription: input.seoDescription ?? null
		})
		.onConflictDoNothing({ target: pages.slug })
		.returning({ id: pages.id });
	return inserted.length ? 'created' : 'exists';
}
