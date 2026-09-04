import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { orders, shipments } from '../../../lib/modules/shop/schema.ts';

// FIX-11 (audit P1 "shipment-sync starvation"): a failing courier sync used to
// be invisible outside the function logs. The dashboard load exposes the sync
// health so the shell shows a "sync failing" banner while `error_count > 0`
// rows exist. `$lib/db` is redirected to TEST_DATABASE_URL like the other
// route specs.
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
type Page = typeof import('./+page.server.ts');
let load: Page['load'];

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	load = (await import('./+page.server.ts')).load;
});

afterAll(async () => {
	await (appDbHolder.db as Db | undefined)?.$client.end();
	await db.$client.end();
});

async function loadData(): Promise<{
	shipmentSync: { failing: number; latestError: string | null };
}> {
	return (await load({} as Parameters<Page['load']>[0])) as {
		shipmentSync: { failing: number; latestError: string | null };
	};
}

describe('/admin dashboard load — shipment-sync health', () => {
	it('reports nothing while no in-flight row has failed a poll', async () => {
		expect(await loadData()).toEqual({ shipmentSync: { failing: 0, latestError: null } });
	});

	it('counts failing in-flight rows and surfaces the latest error text', async () => {
		const [order] = await db
			.insert(orders)
			.values({
				id: 'dash-order-1',
				email: 'client@example.ro',
				stripeSessionId: 'cs_dash_1',
				amountTotalCents: 1000,
				currency: 'ron',
				status: 'paid',
				fulfillmentStatus: 'shipped'
			})
			.returning();
		await db.insert(shipments).values([
			{
				id: 'dash-ship-1',
				orderId: order.id,
				provider: 'mock',
				awb: 'MOCKAWB-DASH-1',
				status: 'registered',
				errorCount: 2,
				lastError: 'Sameday status lookup failed (HTTP 500): boom'
			}
		]);
		expect(await loadData()).toEqual({
			shipmentSync: { failing: 1, latestError: 'Sameday status lookup failed (HTTP 500): boom' }
		});

		// A delivered row with an old error is history, not a live failure.
		await db.update(shipments).set({ status: 'delivered' });
		expect((await loadData()).shipmentSync.failing).toBe(0);
	});
});
