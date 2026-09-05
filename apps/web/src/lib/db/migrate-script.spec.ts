import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

/**
 * FIX-16: `pnpm db:migrate` is `scripts/migrate.ts` — advisory lock, then
 * drizzle-kit migrate, then the concurrent indexes. Two runs started at the
 * same instant against a FRESH database must both exit 0 with the schema
 * applied exactly once (without the lock, both would try to create the
 * first table and one would die on "relation already exists").
 */
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is not set — see .env.example');

const SCRATCH_DB = 'better_migrate_spec';
const scratchUrl = (() => {
	const url = new URL(testUrl);
	url.pathname = `/${SCRATCH_DB}`;
	return url.toString();
})();
const run = promisify(execFile);
const scriptsDir = path.resolve(import.meta.dirname, '../../../scripts');

async function withAdmin(fn: (client: pg.Client) => Promise<void>): Promise<void> {
	const client = new pg.Client({ connectionString: testUrl });
	await client.connect();
	try {
		await fn(client);
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	await withAdmin(async (client) => {
		await client.query(`drop database if exists ${SCRATCH_DB} with (force)`);
		await client.query(`create database ${SCRATCH_DB}`);
	});
});

afterAll(async () => {
	await withAdmin(async (client) => {
		await client.query(`drop database if exists ${SCRATCH_DB} with (force)`);
	});
});

function migrateScript(): Promise<{ stdout: string; stderr: string }> {
	return run('node', [path.join(scriptsDir, 'migrate.ts')], {
		cwd: path.resolve(scriptsDir, '..'),
		env: { ...process.env, DATABASE_URL: scratchUrl, DIRECT_DATABASE_URL: '' },
		timeout: 120_000
	});
}

describe('scripts/migrate.ts', () => {
	it('two concurrent runs against a fresh database both succeed and apply the schema once', async () => {
		const [a, b] = await Promise.all([migrateScript(), migrateScript()]);
		expect(a.stdout + b.stdout).toContain('db:migrate — lock acquired');

		const status = await run('node', [path.join(scriptsDir, 'migrate-status.ts')], {
			cwd: path.resolve(scriptsDir, '..'),
			env: { ...process.env, DATABASE_URL: scratchUrl, DIRECT_DATABASE_URL: '' }
		});
		expect(status.stdout).toMatch(/db:status — up to date/);
		expect(status.stdout).not.toContain('PENDING');

		// The concurrent index ran too, and exactly one migration row per file.
		const client = new pg.Client({ connectionString: scratchUrl });
		await client.connect();
		try {
			const index = await client.query(
				`select indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'site_settings_updated_by_idx'`
			);
			expect(index.rows).toEqual([{ indisvalid: true }]);
			const dupes = await client.query(
				`select created_at, count(*) from drizzle.__drizzle_migrations group by created_at having count(*) > 1`
			);
			expect(dupes.rows).toEqual([]);
		} finally {
			await client.end();
		}
	}, 180_000);
});
