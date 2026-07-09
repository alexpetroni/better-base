import { eq, ilike, or } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { nextUniqueSlug, slugify } from '../util/slug.ts';
import type { Db } from './client.ts';

/**
 * Slug uniqueness against a table, shared by every sluggable entity
 * (articles, products, quizzes, pages). One query fetches the base slug and
 * all its `-N` suffixes; the free candidate is picked in memory.
 */

export interface SlugColumns {
	table: PgTable;
	id: AnyPgColumn;
	slug: AnyPgColumn;
}

/** Is `slug` already used by a row other than `excludeId`? */
export async function slugTaken(
	db: Db,
	cols: SlugColumns,
	slug: string,
	excludeId?: string
): Promise<boolean> {
	const rows = await db.select({ id: cols.id }).from(cols.table).where(eq(cols.slug, slug));
	return rows.some((r) => r.id !== excludeId);
}

/**
 * Derive a free slug from a title (or explicit base): slugify, fall back to
 * `fallback` when that comes out empty, then suffix `-2`, `-3`, … past
 * existing rows. Rows matching `excludeId` don't count, so re-saving your
 * own slug keeps it.
 */
export async function ensureUniqueSlug(
	db: Db,
	cols: SlugColumns,
	base: string,
	fallback: string,
	excludeId?: string
): Promise<string> {
	const root = slugify(base) || fallback;
	const taken = await db
		.select({ slug: cols.slug, id: cols.id })
		.from(cols.table)
		.where(or(eq(cols.slug, root), ilike(cols.slug, `${root}-%`)));
	const takenSet = new Set(taken.filter((r) => r.id !== excludeId).map((r) => r.slug));
	return nextUniqueSlug(root, (slug) => takenSet.has(slug));
}
