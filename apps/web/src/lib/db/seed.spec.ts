import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolveSiteConfig } from '../config/index.ts';
import { createDb, type Db } from './client.ts';
import { pillars } from './schema/core.ts';
import { seedPillars } from './seed.ts';

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
