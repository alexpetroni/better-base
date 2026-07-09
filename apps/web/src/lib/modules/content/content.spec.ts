import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { count, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FormConfig } from 'formcomp';
import { resolveSiteConfig } from '../../config/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { seedPillars } from '../../db/seed.ts';
import { articlePillars, articles } from '../blog/schema.ts';
import { storageConfigFromEnv } from '../media/env.ts';
import { media } from '../media/schema.ts';
import { createStorage, type Storage } from '../media/storage.ts';
import { quizzes } from '../quiz/schema.ts';
import { SLEEP_QUIZ_SEED } from '../quiz/seed-quiz.ts';
import type { ScoringConfig } from '../quiz/scoring.ts';
import { productPillars, products } from '../shop/schema.ts';
import type { ContentBundle } from './bundle.ts';
import { exportContent, type ContentDeps } from './export.ts';
import { importContent } from './import.ts';

// The cross-site content sharing round trip, tested exactly as it will be
// used: TWO databases (source A gets all 9 pillars like better-life, target B
// only `somn` like better-sleep) and TWO buckets. Export from A, import into
// B, import twice → no duplicates anywhere.

const FIXTURE = path.resolve(import.meta.dirname, '../../../../tests/fixtures/test-image.png');

let dbA: Db;
let dbB: Db;
let storageA: Storage;
let storageB: Storage;
let depsA: ContentDeps;
let depsB: ContentDeps;
let fixtureBytes: Buffer;

async function resetDatabase(db: Db) {
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
}

beforeAll(async () => {
	const urlA = process.env.TEST_DATABASE_URL;
	if (!urlA) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	const storageCfg = storageConfigFromEnv(process.env);
	if (!storageCfg.endpoint) {
		throw new Error('S3_* env vars are not set — start `docker compose up -d`');
	}

	// Second database next to the test one (created on demand, reused after).
	const urlB = new URL(urlA);
	urlB.pathname = '/better_test_b';
	dbA = createDb(urlA);
	try {
		await dbA.execute(sql`create database better_test_b`);
	} catch (err) {
		// 42P04 = already exists (fresh volumes pre-create it via postgres-init).
		// Drizzle wraps the pg error, so the code may sit on the cause.
		const e = err as { code?: string; cause?: { code?: string } };
		if (e.code !== '42P04' && e.cause?.code !== '42P04') throw err;
	}
	dbB = createDb(urlB.toString());

	await resetDatabase(dbA);
	await resetDatabase(dbB);
	// A carries all 9 pillars — deliberately in a rotated order so `somn` gets
	// a DIFFERENT numeric id than in B, proving mapping happens by slug.
	const life = resolveSiteConfig('life').pillars;
	await seedPillars(dbA, [...life.filter((s) => s !== 'somn'), 'somn']);
	await seedPillars(dbB, resolveSiteConfig('sleep').pillars);

	storageA = createStorage({ ...storageCfg, bucket: 'better-base-content-a' });
	storageB = createStorage({ ...storageCfg, bucket: 'better-base-content-b' });
	await storageA.ensureBucket();
	await storageB.ensureBucket();
	depsA = { db: dbA, storage: storageA };
	depsB = { db: dbB, storage: storageB };
	fixtureBytes = await readFile(FIXTURE);
});

afterAll(async () => {
	await dbA?.$client.end();
	await dbB?.$client.end();
});

async function pillarIdBySlug(db: Db, slug: string): Promise<number> {
	const [row] = await db.select().from(pillars).where(eq(pillars.slug, slug));
	if (!row) throw new Error(`pillar ${slug} not seeded`);
	return row.id;
}

async function insertImage(db: Db, storage: Storage, id: string, key: string, blurhash?: string) {
	await storage.putObject(key, fixtureBytes, 'image/png');
	await db.insert(media).values({
		id,
		kind: 'image',
		key,
		filename: 'test-image.png',
		mime: 'image/png',
		size: fixtureBytes.byteLength,
		width: 320,
		height: 200,
		alt: 'imagine de test',
		blurhash: blurhash ?? null
	});
}

describe('article export → import between two databases', () => {
	const COVER_ID = 'content-a-cover';
	const COVER_KEY = 'uploads/content-spec/article-cover.png';
	const COVER_BLURHASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
	const INLINE_ID = 'content-a-inline';
	const INLINE_KEY = 'uploads/content-spec/article-inline.png';

	beforeAll(async () => {
		await insertImage(dbA, storageA, COVER_ID, COVER_KEY, COVER_BLURHASH);
		await insertImage(dbA, storageA, INLINE_ID, INLINE_KEY);
		await dbA.insert(articles).values({
			id: 'content-a-article',
			slug: 'articol-partajat',
			title: 'Articol partajat',
			excerpt: 'Rezumat',
			bodyMd: `Intro\n\n![inline](media:${INLINE_ID})\n\n![prin cheie](media:${COVER_KEY})`,
			coverMediaId: COVER_ID,
			status: 'published',
			publishedAt: new Date('2026-07-01T10:00:00Z'),
			seoTitle: 'SEO titlu',
			seoDescription: 'SEO descriere'
		});
		await dbA.insert(articlePillars).values([
			{ articleId: 'content-a-article', pillarId: await pillarIdBySlug(dbA, 'somn') },
			{ articleId: 'content-a-article', pillarId: await pillarIdBySlug(dbA, 'nutritie') }
		]);
	});

	it('round-trips with media bytes, and a second import creates no duplicates', async () => {
		const exported = await exportContent(depsA, { type: 'article', slug: 'articol-partajat' });
		expect(exported.ok).toBe(true);
		if (!exported.ok) return;
		const bundle = exported.value;
		expect(bundle.pillars.sort()).toEqual(['nutritie', 'somn']);
		expect(bundle.media).toHaveLength(2);
		for (const d of bundle.media) {
			expect(d.dataBase64).toBeTruthy();
			expect(Buffer.from(d.dataBase64 as string, 'base64').byteLength).toBe(
				fixtureBytes.byteLength
			);
		}

		// Serialize/parse like the CLI does: files on disk are the real interface.
		const wire = JSON.parse(JSON.stringify(bundle));
		const first = await importContent(depsB, wire);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.action).toBe('created');
		expect(first.value.mediaCreated).toBe(2);
		expect(first.value.pillarsTagged).toEqual(['somn']);
		expect(first.value.pillarsSkipped).toEqual(['nutritie']); // not seeded on the sleep-like DB

		// Media landed in the TARGET bucket, rows keep their keys (source ids are free in B).
		const statB = await storageB.statObject(COVER_KEY);
		expect(statB?.size).toBe(fixtureBytes.byteLength);
		// blurhash round-trips (silently dropped before the Theme D fix).
		const [coverB] = await dbB.select().from(media).where(eq(media.key, COVER_KEY));
		expect(coverB.blurhash).toBe(COVER_BLURHASH);
		const [inlineB] = await dbB.select().from(media).where(eq(media.key, INLINE_KEY));
		expect(inlineB.blurhash).toBeNull();
		const [imported] = await dbB
			.select()
			.from(articles)
			.where(eq(articles.slug, 'articol-partajat'));
		expect(imported.status).toBe('published');
		expect(imported.publishedAt?.toISOString()).toBe('2026-07-01T10:00:00.000Z');
		expect(imported.coverMediaId).toBe(COVER_ID);
		expect(imported.bodyMd).toContain(`media:${INLINE_ID}`);
		expect(imported.bodyMd).toContain(`media:${COVER_KEY}`);
		const somnB = await pillarIdBySlug(dbB, 'somn');
		const joins = await dbB
			.select()
			.from(articlePillars)
			.where(eq(articlePillars.articleId, imported.id));
		expect(joins.map((j) => j.pillarId)).toEqual([somnB]);

		const second = await importContent(depsB, wire);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.action).toBe('updated');
		expect(second.value.mediaCreated).toBe(0);
		expect(second.value.mediaReused).toBe(2);
		const [articleCount] = await dbB
			.select({ n: count() })
			.from(articles)
			.where(eq(articles.slug, 'articol-partajat'));
		expect(articleCount.n).toBe(1);
		const [mediaCount] = await dbB
			.select({ n: count() })
			.from(media)
			.where(eq(media.key, COVER_KEY));
		expect(mediaCount.n).toBe(1);
		const joinsAfter = await dbB
			.select()
			.from(articlePillars)
			.where(eq(articlePillars.articleId, imported.id));
		expect(joinsAfter).toHaveLength(1);
	});

	it('remaps media ids when the source id is taken by a different row in the target', async () => {
		const TAKEN_ID = 'content-a-collide';
		const SRC_KEY = 'uploads/content-spec/collide-src.png';
		await insertImage(dbA, storageA, TAKEN_ID, SRC_KEY);
		// Same id exists in B but points to a DIFFERENT object.
		await insertImage(dbB, storageB, TAKEN_ID, 'uploads/content-spec/collide-other.png');
		await dbA.insert(articles).values({
			id: 'content-a-collide-article',
			slug: 'articol-coliziune',
			title: 'Coliziune',
			bodyMd: `![x](media:${TAKEN_ID})`,
			coverMediaId: TAKEN_ID,
			status: 'draft'
		});

		const exported = await exportContent(depsA, { type: 'article', slug: 'articol-coliziune' });
		expect(exported.ok).toBe(true);
		if (!exported.ok) return;
		const imported = await importContent(depsB, JSON.parse(JSON.stringify(exported.value)));
		expect(imported.ok).toBe(true);

		const [row] = await dbB.select().from(articles).where(eq(articles.slug, 'articol-coliziune'));
		expect(row.coverMediaId).not.toBeNull();
		expect(row.coverMediaId).not.toBe(TAKEN_ID);
		expect(row.bodyMd).toBe(`![x](media:${row.coverMediaId})`);
		const [newRow] = await dbB
			.select()
			.from(media)
			.where(eq(media.id, row.coverMediaId as string));
		expect(newRow.key).toBe(SRC_KEY);
	});
});

describe('quiz export → import', () => {
	it('maps the pillar by slug (ids differ between databases) and stays unique', async () => {
		const somnA = await pillarIdBySlug(dbA, 'somn');
		const somnB = await pillarIdBySlug(dbB, 'somn');
		expect(somnA).not.toBe(somnB); // rotated seeding order in A — see beforeAll
		await dbA.insert(quizzes).values({
			id: 'content-a-quiz',
			slug: 'chestionar-partajat',
			title: 'Chestionar partajat',
			introMd: 'Intro **md**',
			pillarId: somnA,
			formSchema: SLEEP_QUIZ_SEED.formSchema as unknown as FormConfig,
			scoring: SLEEP_QUIZ_SEED.scoring as unknown as ScoringConfig,
			status: 'published'
		});

		const exported = await exportContent(depsA, { type: 'quiz', slug: 'chestionar-partajat' });
		expect(exported.ok).toBe(true);
		if (!exported.ok) return;
		expect(exported.value.pillars).toEqual(['somn']);

		const wire = JSON.parse(JSON.stringify(exported.value));
		const first = await importContent(depsB, wire);
		expect(first.ok ? first.value.action : first).toBe('created');
		const second = await importContent(depsB, wire);
		expect(second.ok ? second.value.action : second).toBe('updated');

		const rows = await dbB.select().from(quizzes).where(eq(quizzes.slug, 'chestionar-partajat'));
		expect(rows).toHaveLength(1);
		expect(rows[0].pillarId).toBe(somnB);
		expect(rows[0].status).toBe('published');
		expect(rows[0].formSchema).toEqual(JSON.parse(JSON.stringify(SLEEP_QUIZ_SEED.formSchema)));
		expect(rows[0].scoring).toEqual(JSON.parse(JSON.stringify(SLEEP_QUIZ_SEED.scoring)));
	});
});

describe('product export → import', () => {
	it('round-trips cover + gallery and never copies Stripe catalog ids', async () => {
		const COVER = 'content-a-prod-cover';
		const GALLERY = 'content-a-prod-gallery';
		await insertImage(dbA, storageA, COVER, 'uploads/content-spec/prod-cover.png');
		await insertImage(dbA, storageA, GALLERY, 'uploads/content-spec/prod-gallery.png');
		await dbA.insert(products).values({
			id: 'content-a-product',
			slug: 'produs-partajat',
			name: 'Produs partajat',
			descriptionMd: `Descriere\n\n![galerie](media:${GALLERY})`,
			priceCents: 12345,
			currency: 'ron',
			stripeProductId: 'prod_sourceSiteOnly',
			stripePriceId: 'price_sourceSiteOnly',
			status: 'active',
			coverMediaId: COVER,
			gallery: [GALLERY],
			stock: 7
		});
		await dbA.insert(productPillars).values({
			productId: 'content-a-product',
			pillarId: await pillarIdBySlug(dbA, 'somn')
		});

		const exported = await exportContent(depsA, { type: 'product', slug: 'produs-partajat' });
		expect(exported.ok).toBe(true);
		if (!exported.ok) return;
		const wire = JSON.parse(JSON.stringify(exported.value));
		const first = await importContent(depsB, wire);
		expect(first.ok ? first.value.action : first).toBe('created');
		const second = await importContent(depsB, wire);
		expect(second.ok ? second.value.action : second).toBe('updated');

		const rows = await dbB.select().from(products).where(eq(products.slug, 'produs-partajat'));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.priceCents).toBe(12345);
		expect(row.stock).toBe(7);
		expect(row.status).toBe('active');
		// Stripe ids belong to the source site's account — never imported.
		expect(row.stripeProductId).toBeNull();
		expect(row.stripePriceId).toBeNull();
		expect(row.coverMediaId).toBe(COVER);
		expect(row.gallery).toEqual([GALLERY]);
		const joins = await dbB
			.select()
			.from(productPillars)
			.where(eq(productPillars.productId, row.id));
		expect(joins).toHaveLength(1);
	});
});

describe('export failure modes', () => {
	it('reports unknown slugs', async () => {
		const result = await exportContent(depsA, { type: 'article', slug: 'nu-exista' });
		expect(result).toEqual({ ok: false, error: 'not-found', detail: 'article "nu-exista"' });
	});

	it('refuses to export when a referenced object is missing from storage', async () => {
		await dbA.insert(media).values({
			id: 'content-a-ghost',
			kind: 'image',
			key: 'uploads/content-spec/ghost.png',
			filename: 'ghost.png',
			mime: 'image/png',
			size: 1
		});
		await dbA.insert(articles).values({
			id: 'content-a-ghost-article',
			slug: 'articol-fantoma',
			title: 'Fantomă',
			bodyMd: '',
			coverMediaId: 'content-a-ghost',
			status: 'draft'
		});
		const result = await exportContent(depsA, { type: 'article', slug: 'articol-fantoma' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe('missing-object');
	});
});
