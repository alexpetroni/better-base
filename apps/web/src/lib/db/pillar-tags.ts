import { eq, inArray } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client.ts';
import { pillars, type Pillar } from './schema/core.ts';

/**
 * The pillar many-to-many shared by articles and products: resolve slugs to
 * rows, replace a parent's join rows, read a parent's slugs back. Callers
 * describe their join table once (see `PillarJoin`).
 */

export interface PillarJoin<T extends PgTable = PgTable> {
	table: T;
	parentId: AnyPgColumn;
	pillarId: AnyPgColumn;
	/** Build one join row — the property names differ per table. */
	link: (parentId: string, pillarId: number) => T['$inferInsert'];
}

/** A db or an in-flight transaction — setPillars runs inside the caller's tx. */
type DbConn = Pick<Db, 'select' | 'insert' | 'delete'>;

export type ResolvedPillars = { ok: true; rows: Pillar[] } | { ok: false; missing: string[] };

/** Resolve pillar slugs to rows; unknown slugs are reported, none are guessed. */
export async function resolvePillarRows(db: DbConn, slugs: string[]): Promise<ResolvedPillars> {
	const unique = [...new Set(slugs)];
	const rows = unique.length
		? await db.select().from(pillars).where(inArray(pillars.slug, unique))
		: [];
	if (rows.length !== unique.length) {
		const known = new Set(rows.map((r) => r.slug));
		return { ok: false, missing: unique.filter((s) => !known.has(s)) };
	}
	return { ok: true, rows };
}

/** Replace the parent's pillar links (delete + re-insert, caller's tx). */
export async function setPillars<T extends PgTable>(
	tx: DbConn,
	join: PillarJoin<T>,
	parentId: string,
	pillarRows: Pillar[]
): Promise<void> {
	await tx.delete(join.table).where(eq(join.parentId, parentId));
	if (pillarRows.length) {
		await tx.insert(join.table).values(pillarRows.map((p) => join.link(parentId, p.id)));
	}
}

/** The parent's pillar slugs, in canonical `pillars.sort` order. */
export async function pillarSlugsFor(
	db: DbConn,
	join: PillarJoin,
	parentId: string
): Promise<string[]> {
	const rows = await db
		.select({ slug: pillars.slug })
		.from(join.table)
		.innerJoin(pillars, eq(join.pillarId, pillars.id))
		.where(eq(join.parentId, parentId))
		.orderBy(pillars.sort);
	return rows.map((r) => r.slug);
}
