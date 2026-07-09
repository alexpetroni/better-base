import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolveSiteConfig } from '../config/index.ts';
import { createDb, type Db } from './client.ts';
import { articlePillars, articles } from '../modules/blog/schema.ts';
import { storageConfigFromEnv } from '../modules/media/env.ts';
import { media } from '../modules/media/schema.ts';
import { createStorage } from '../modules/media/storage.ts';
import { quizzes } from '../modules/quiz/schema.ts';
import { productPillars, products } from '../modules/shop/schema.ts';
import { pillars } from './schema/core.ts';
import { seedDemoArticles, seedDemoProducts, seedDemoQuiz, seedPillars } from './seed.ts';

// Integration test against the compose Postgres: uses the dedicated test
// database (TEST_DATABASE_URL), reset and re-migrated fresh on every run.
let db: Db;

async function countPillars(): Promise<number> {
	return (await db.select().from(pillars)).length;
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			'TEST_DATABASE_URL is not set — start the database with `docker compose up -d db` and configure .env'
		);
	}
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle')
	});
});

afterAll(async () => {
	await db?.$client.end();
});

describe('seedPillars', () => {
	it('seeds the single sleep pillar on a fresh database', async () => {
		const site = resolveSiteConfig('sleep');
		await expect(seedPillars(db, site.pillars)).resolves.toBe(1);
		expect(await countPillars()).toBe(1);
	});

	it('is idempotent: re-seeding never duplicates rows', async () => {
		const site = resolveSiteConfig('life');
		await seedPillars(db, site.pillars);
		const afterFirst = await countPillars();
		expect(afterFirst).toBe(9);

		await seedPillars(db, site.pillars);
		expect(await countPillars()).toBe(afterFirst);
	});

	it('rejects a slug that is not canonical', async () => {
		await expect(seedPillars(db, ['nope'])).rejects.toThrow(/unknown pillar slug/);
	});
});

describe('seedDemoArticles', () => {
	it('seeds 3 published articles tagged to somn, idempotently', async () => {
		// Pillars are present from the seedPillars tests above.
		await expect(seedDemoArticles(db)).resolves.toBe(3);
		const rows = await db.select().from(articles);
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.status === 'published' && r.publishedAt)).toBe(true);

		await seedDemoArticles(db);
		expect(await db.select().from(articles)).toHaveLength(3);
		expect(await db.select().from(articlePillars)).toHaveLength(3);
	});
});

describe('seedDemoProducts', () => {
	it('seeds 3 active somn-tagged products with placeholder images, idempotently', async () => {
		// Pillars are present from the seedPillars tests above. Placeholder
		// uploads go to the compose MinIO (same requirement as media specs).
		const storage = createStorage(storageConfigFromEnv(process.env));
		await storage.ensureBucket();

		await expect(seedDemoProducts(db, storage)).resolves.toBe(3);
		await seedDemoProducts(db, storage);

		const rows = await db.select().from(products);
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.status === 'active' && r.priceCents > 0)).toBe(true);
		expect(rows.every((r) => r.coverMediaId)).toBe(true);
		expect(await db.select().from(productPillars)).toHaveLength(3);

		// Every referenced image row exists and its object is really in storage.
		const mediaRows = await db.select().from(media);
		const seedImages = mediaRows.filter((r) => r.id.startsWith('seed-media-'));
		expect(seedImages).toHaveLength(4);
		for (const image of seedImages) {
			const stat = await storage.statObject(image.key!);
			expect(stat?.mime).toBe('image/svg+xml');
		}
	});
});

describe('seedDemoQuiz', () => {
	it('seeds one published, somn-tagged quiz, idempotently', async () => {
		// Pillars are present from the seedPillars tests above.
		await expect(seedDemoQuiz(db)).resolves.toBe('evaluare-somn');
		await seedDemoQuiz(db);

		const rows = await db.select().from(quizzes);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('published');
		expect(rows[0].pillarId).not.toBeNull();
		expect(rows[0].scoring.bands).toHaveLength(3);
	});
});
