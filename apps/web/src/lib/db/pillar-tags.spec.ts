import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { articlePillars, articles } from '../modules/blog/schema.ts';
import { users } from '../modules/auth/schema.ts';
import { createDb, type Db } from './client.ts';
import { pillarSlugsFor, resolvePillarRows, setPillars, type PillarJoin } from './pillar-tags.ts';
import { seedPillars } from './seed.ts';
import { ensureUniqueSlug, slugTaken } from './unique-slug.ts';

// Integration test for the shared pillar-join + unique-slug helpers, run
// against the articles tables (the same descriptors blog/service.ts uses).
let db: Db;

const USER_ID = 'pillar-tags-spec-user';

const ARTICLE_PILLARS: PillarJoin<typeof articlePillars> = {
	table: articlePillars,
	parentId: articlePillars.articleId,
	pillarId: articlePillars.pillarId,
	link: (articleId, pillarId) => ({ articleId, pillarId })
};

const ARTICLE_SLUGS = { table: articles, id: articles.id, slug: articles.slug };

async function insertArticle(id: string, slug: string): Promise<void> {
	await db.insert(articles).values({ id, slug, title: slug, createdBy: USER_ID });
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') });
	await seedPillars(db, ['somn', 'nutritie', 'miscare']);
	await db.insert(users).values({ id: USER_ID, name: 'Spec', email: 'pillar-tags@example.com' });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('resolvePillarRows', () => {
	it('resolves known slugs (deduped) and reports unknown ones without guessing', async () => {
		const ok = await resolvePillarRows(db, ['somn', 'nutritie', 'somn']);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.rows.map((r) => r.slug).sort()).toEqual(['nutritie', 'somn']);

		const bad = await resolvePillarRows(db, ['somn', 'nope', 'inca-nu']);
		expect(bad).toEqual({ ok: false, missing: ['nope', 'inca-nu'] });

		const empty = await resolvePillarRows(db, []);
		expect(empty).toEqual({ ok: true, rows: [] });
	});
});

describe('setPillars + pillarSlugsFor', () => {
	it('replaces the join rows and reads slugs back in canonical sort order', async () => {
		await insertArticle('a1', 'a1');
		const first = await resolvePillarRows(db, ['miscare', 'somn']);
		if (!first.ok) throw new Error('unexpected');
		await setPillars(db, ARTICLE_PILLARS, 'a1', first.rows);
		// Seeded order somn(0), nutritie(1), miscare(2) — not insertion order.
		expect(await pillarSlugsFor(db, ARTICLE_PILLARS, 'a1')).toEqual(['somn', 'miscare']);

		const second = await resolvePillarRows(db, ['nutritie']);
		if (!second.ok) throw new Error('unexpected');
		await setPillars(db, ARTICLE_PILLARS, 'a1', second.rows);
		expect(await pillarSlugsFor(db, ARTICLE_PILLARS, 'a1')).toEqual(['nutritie']);

		await setPillars(db, ARTICLE_PILLARS, 'a1', []);
		expect(await pillarSlugsFor(db, ARTICLE_PILLARS, 'a1')).toEqual([]);
	});
});

describe('ensureUniqueSlug + slugTaken', () => {
	it('falls back on empty input, suffixes past collisions, ignores excludeId', async () => {
		expect(await ensureUniqueSlug(db, ARTICLE_SLUGS, '', 'articol')).toBe('articol');

		await insertArticle('s1', 'ghid-somn');
		await insertArticle('s2', 'ghid-somn-2');
		expect(await ensureUniqueSlug(db, ARTICLE_SLUGS, 'Ghid Somn', 'articol')).toBe('ghid-somn-3');
		// Re-saving your own slug keeps it.
		expect(await ensureUniqueSlug(db, ARTICLE_SLUGS, 'ghid-somn', 'articol', 's1')).toBe(
			'ghid-somn'
		);

		expect(await slugTaken(db, ARTICLE_SLUGS, 'ghid-somn')).toBe(true);
		expect(await slugTaken(db, ARTICLE_SLUGS, 'ghid-somn', 's1')).toBe(false);
		expect(await slugTaken(db, ARTICLE_SLUGS, 'liber')).toBe(false);
	});
});
