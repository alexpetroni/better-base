import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { CourierAuthError } from '../../../../lib/modules/shop/courier.ts';
import type { MockCourierProvider } from '../../../../lib/modules/shop/mock-courier.ts';
import { orders, shipments } from '../../../../lib/modules/shop/schema.ts';

// The shipment-sync cron route under the existing cron-auth rules: missing
// CRON_SECRET is 503 (an unconfigured deploy never falls open), a missing or
// wrong bearer is 401, and an authorized run against a database with nothing
// in flight is a pure no-op — the serverless-safe steady state.

// $env/dynamic/private is a build-time snapshot under vitest — swap it for a
// mutable holder so each test controls CRON_SECRET.
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
		request: new Request('http://localhost/api/cron/shipment-sync', {
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
	vi.restoreAllMocks();
});

afterAll(async () => {
	await db.$client.end();
});

describe('GET /api/cron/shipment-sync', () => {
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

	it('an authorized run with nothing in flight is a no-op', async () => {
		envHolder.env.CRON_SECRET = 'cron-test-secret';
		const response = await get(requestEvent('Bearer cron-test-secret'));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ polled: 0, updated: 0, errors: 0 });
	});

	// FIX-11 (audit P1 "shipment-sync starvation"): an auth failure used to
	// fail every row silently; the run must abort, log at error level and say
	// so in the response the scheduler sees.
	it('reports an aborted run when the courier rejects the credentials', async () => {
		envHolder.env.CRON_SECRET = 'cron-test-secret';
		const [order] = await db
			.insert(orders)
			.values({
				id: 'sync-route-order',
				email: 'client@example.ro',
				stripeSessionId: 'cs_sync_route',
				amountTotalCents: 1000,
				currency: 'ron',
				status: 'paid',
				fulfillmentStatus: 'shipped'
			})
			.returning();
		await db.insert(shipments).values({
			id: 'sync-route-shipment',
			orderId: order.id,
			provider: 'mock',
			awb: 'MOCKAWB-ROUTE',
			status: 'registered'
		});
		// The route resolves the server-barrel courier singleton (the mock).
		const { getCourierProvider } = await import('../../../../lib/modules/shop/server.ts');
		const courier = getCourierProvider() as MockCourierProvider;
		courier.trackFailures.set(
			'MOCKAWB-ROUTE',
			new CourierAuthError('Sameday authentication failed')
		);
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await get(requestEvent('Bearer cron-test-secret'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ polled: 1, updated: 0, errors: 1, aborted: 'auth' });
		expect(errorLog).toHaveBeenCalled();
		const [row] = await db.select().from(shipments).where(eq(shipments.id, 'sync-route-shipment'));
		expect(row.errorCount).toBe(1);
		expect(row.lastError).toContain('authentication failed');
		courier.trackFailures.delete('MOCKAWB-ROUTE');
	});
});
