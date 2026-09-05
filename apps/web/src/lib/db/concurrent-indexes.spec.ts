import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './client.ts';
import { applyConcurrentIndexes, CONCURRENT_INDEXES } from './concurrent-indexes.ts';

/**
 * FIX-16 (audit "Migration contract"): drizzle applies every pending file in
 * ONE transaction, where `CREATE INDEX CONCURRENTLY` is illegal — so indexes
 * on tables that may already be large go through this runner (autocommit,
 * `IF NOT EXISTS`, idempotent), after `db:migrate`. The first entry is the
 * `site_settings.updated_by` FK index the audit found missing.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');

let db: Db;

beforeAll(async () => {
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') });
});

afterAll(async () => {
	await db?.$client.end();
});

async function indexState(name: string): Promise<{ valid: boolean } | null> {
	const result = await db.execute(sql`
		select i.indisvalid as valid from pg_class c
			join pg_index i on i.indexrelid = c.oid
			where c.relname = ${name}
	`);
	const row = result.rows[0] as { valid: boolean } | undefined;
	return row ? { valid: row.valid } : null;
}

describe('applyConcurrentIndexes', () => {
	it('declares the site_settings.updated_by index the audit found missing', () => {
		expect(CONCURRENT_INDEXES.map((index) => index.name)).toContain('site_settings_updated_by_idx');
		for (const index of CONCURRENT_INDEXES) {
			expect(index.sql).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
			expect(index.sql).toContain(index.name);
		}
	});

	it('creates every declared index, valid, and is a no-op on the second run', async () => {
		expect(await indexState('site_settings_updated_by_idx')).toBeNull();

		const first = await applyConcurrentIndexes(url);
		expect(first).toEqual(CONCURRENT_INDEXES.map((index) => ({ name: index.name, created: true })));
		expect(await indexState('site_settings_updated_by_idx')).toEqual({ valid: true });

		const second = await applyConcurrentIndexes(url);
		expect(second).toEqual(
			CONCURRENT_INDEXES.map((index) => ({ name: index.name, created: false }))
		);
		expect(await indexState('site_settings_updated_by_idx')).toEqual({ valid: true });
	});
});
