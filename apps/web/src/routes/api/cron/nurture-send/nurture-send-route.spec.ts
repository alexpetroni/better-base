import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../../lib/db/client.ts';

// The nurture-send cron route under the existing cron-auth rules: missing
// CRON_SECRET is 503 (an unconfigured deploy never falls open), a missing or
// wrong bearer is 401, and an authorized run against an empty queue is a pure
// no-op — the serverless-safe steady state.

// $env/dynamic/private is a build-time snapshot under vitest — swap it for a
// mutable holder so each test controls CRON_SECRET.
// SITE_ID present: the drain deps resolve the site for name + email sender.
const envHolder = vi.hoisted(() => ({
	env: { SITE_ID: 'sleep' } as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => ({ env: envHolder.env }));
// The drain deps need the public origin for unsubscribe links.
vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_SITE_URL: 'https://example.ro' }
}));

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
		request: new Request('http://localhost/api/cron/nurture-send', {
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
	get = (await import('./+server.ts')).GET;
});

afterEach(() => {
	delete envHolder.env.CRON_SECRET;
});

afterAll(async () => {
	await db.$client.end();
});

describe('GET /api/cron/nurture-send', () => {
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

	it('an authorized run with nothing due is a no-op', async () => {
		envHolder.env.CRON_SECRET = 'cron-test-secret';
		const response = await get(requestEvent('Bearer cron-test-secret'));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			claimed: 0,
			sent: 0,
			retried: 0,
			parked: 0,
			cancelled: 0,
			stale: 0,
			completed: 0
		});
	});
});
