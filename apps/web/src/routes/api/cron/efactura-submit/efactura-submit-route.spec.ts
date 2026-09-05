import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../../lib/db/client.ts';

// The e-Factura submission cron route under the cron-auth rules shared by
// every scheduled route: missing CRON_SECRET is 503 (never falls open), a
// missing or wrong bearer is 401, and an authorized run with nothing pending
// is a pure no-op that reports the drain counters.

const envHolder = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: envHolder.env }));

const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
type Route = typeof import('./+server.ts');
let get: Route['GET'];

function requestEvent(authorization?: string) {
	return {
		request: new Request('http://localhost/api/cron/efactura-submit', {
			headers: authorization ? { authorization } : {}
		})
	} as unknown as Parameters<Route['GET']>[0];
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../../drizzle')
	});
	// The route builds the fiscal storage singleton from env: hand it the
	// local MinIO configuration the test stack runs with.
	for (const name of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION']) {
		envHolder.env[name] = process.env[name];
	}
	get = (await import('./+server.ts')).GET;
});

afterEach(() => {
	delete envHolder.env.CRON_SECRET;
	vi.restoreAllMocks();
});

afterAll(async () => {
	await db.$client.end();
});

describe('GET /api/cron/efactura-submit', () => {
	it('503s when CRON_SECRET is not configured (never falls open)', async () => {
		delete envHolder.env.CRON_SECRET;
		const response = await get(requestEvent('Bearer anything'));
		expect(response.status).toBe(503);
	});

	it('401s a missing or wrong bearer token', async () => {
		envHolder.env.CRON_SECRET = 'cron-test-secret';
		expect((await get(requestEvent())).status).toBe(401);
		expect((await get(requestEvent('Bearer wrong'))).status).toBe(401);
	});

	it('an authorized run with nothing pending is a no-op reporting the counters', async () => {
		envHolder.env.CRON_SECRET = 'cron-test-secret';
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const response = await get(requestEvent('Bearer cron-test-secret'));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			claimed: 0,
			submitted: 0,
			skipped: 0,
			retried: 0,
			parked: 0
		});
		expect(log).toHaveBeenCalledWith(expect.stringContaining('efactura-submit claimed=0'));
	});
});
