import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { asc, eq, like, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { articlePillars, articles } from '../modules/blog/schema.ts';
import { createDb, DB_POOL_DEFAULTS, type Db, type DbDriver } from './client.ts';
import { pillars } from './schema/core.ts';

// Driver parity: the same service-level operations, executed once under `pg`
// and once under `neon` (the serverless WebSocket driver, through the local
// Neon-protocol proxy), must produce identical results. This is the proof
// behind the `as unknown as Db` cast in client.ts — the compile-time
// assertions there guarantee the SURFACE matches; this spec guarantees the
// BEHAVIOR does. It answers the three unknowns recorded when the neon branch
// shipped unverified (docs/CHANGELOG.md, NEXT-1): the `SET statement_timeout` issued on
// connect is honored, interactive transactions (commit AND rollback) work
// over the WebSocket transport, and the two drivers expose the same runtime
// API. Plus the pooled-connection reality check: parallel work through the
// neon driver's 1-connection default queues instead of deadlocking.
//
// The neon half needs the local proxy: `docker compose --profile neon up -d
// --build`, reached via NEON_WS_PROXY (which `pnpm test:neon` sets — there
// the skip below never fires and vitest-setup.ts fails loudly if the proxy is
// down). Without it only the connection-free surface check runs, so the
// default gate stays independent of the neon profile.

const PROXY = process.env.NEON_WS_PROXY;

function testUrl(): string {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	return url;
}

/** Run `fn` against a driver-explicit client, always closing the pool. */
async function withDb<T>(
	driver: DbDriver,
	fn: (db: Db) => Promise<T>,
	config = DB_POOL_DEFAULTS
): Promise<T> {
	const db = createDb(testUrl(), config, driver);
	try {
		return await fn(db);
	} finally {
		await db.$client.end();
	}
}

/** Drizzle wraps query errors; the pg error text lives in the cause chain. */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		const parts: string[] = [];
		for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
		return parts.join(' | ');
	}
	throw new Error('expected the promise to reject');
}

/** Every property name reachable on `obj`, own and inherited (minus Object.prototype). */
function apiSurface(obj: object): string[] {
	const names = new Set<string>();
	for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
		for (const name of Object.getOwnPropertyNames(o)) {
			if (name !== 'constructor') names.add(name);
		}
	}
	return [...names].sort();
}

describe('driver surface parity (no connection needed)', () => {
	it('the neon client exposes every runtime member the pg client has, including $client.end', async () => {
		// Nothing ever connects to this address — construction only.
		const url = 'postgres://better:better@127.0.0.1:9/never-connected';
		const pgDb = createDb(url, DB_POOL_DEFAULTS, 'pg');
		const neonDb = createDb(url, DB_POOL_DEFAULTS, 'neon');
		try {
			const missing = apiSurface(pgDb).filter((name) => !(name in neonDb));
			expect(missing).toEqual([]);
			expect(typeof neonDb.$client.end).toBe('function');
			expect(typeof neonDb.transaction).toBe('function');
			expect(typeof neonDb.execute).toBe('function');
		} finally {
			await pgDb.$client.end();
			await neonDb.$client.end();
		}
	});
});

describe.skipIf(!PROXY)('driver behavior parity (pg vs neon, integration)', () => {
	// Deterministic timestamps so both drivers produce byte-identical rows.
	const AT = new Date('2026-01-01T12:00:00.000Z');
	let pillarIds: number[] = [];

	beforeAll(async () => {
		const db = createDb(testUrl());
		try {
			await db.execute(sql`drop schema if exists public cascade`);
			await db.execute(sql`drop schema if exists drizzle cascade`);
			await db.execute(sql`create schema public`);
			await migrate(db, {
				migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle')
			});
			const seeded = await db
				.insert(pillars)
				.values([
					{ slug: 'parity-p1', name: 'Parity One' },
					{ slug: 'parity-p2', name: 'Parity Two' }
				])
				.returning({ id: pillars.id });
			pillarIds = seeded.map((row) => row.id);
		} finally {
			await db.$client.end();
		}
	});

	function articleValues(id: string, title: string) {
		return {
			id,
			slug: id,
			title,
			excerpt: 'parity',
			bodyMd: 'parity body',
			publishedAt: AT,
			createdAt: AT,
			updatedAt: AT
		};
	}

	/**
	 * The op set from the phase spec: one insert, one select with a join, one
	 * transaction commit, one transaction rollback. Cleans up after itself so
	 * the next driver starts from the same state and the results can be
	 * compared with a plain deep-equal.
	 */
	async function runOps(db: Db) {
		const inserted = await db.insert(articles).values(articleValues('parity-a1', 'A1')).returning();
		await db.insert(articlePillars).values([
			{ articleId: 'parity-a1', pillarId: pillarIds[0] },
			{ articleId: 'parity-a1', pillarId: pillarIds[1] }
		]);
		const joined = await db
			.select({ article: articles.slug, pillar: pillars.slug })
			.from(articles)
			.innerJoin(articlePillars, eq(articlePillars.articleId, articles.id))
			.innerJoin(pillars, eq(pillars.id, articlePillars.pillarId))
			.where(eq(articles.id, 'parity-a1'))
			.orderBy(asc(pillars.slug));

		const committed = await db.transaction(async (tx) => {
			const rows = await tx
				.insert(articles)
				.values(articleValues('parity-tx', 'Tx'))
				.returning({ id: articles.id });
			return rows[0].id;
		});

		let rollbackError = '';
		try {
			await db.transaction(async (tx) => {
				await tx.insert(articles).values(articleValues('parity-rb', 'Rb'));
				throw new Error('parity rollback probe');
			});
		} catch (err) {
			rollbackError = err instanceof Error ? err.message : String(err);
		}
		const afterRollback = await db
			.select({ id: articles.id })
			.from(articles)
			.where(eq(articles.id, 'parity-rb'));

		await db.delete(articles); // article_pillars rows cascade
		return { inserted, joined, committed, rollbackError, afterRollback };
	}

	it('runs the same insert / join / commit / rollback identically under both drivers', async () => {
		const underPg = await withDb('pg', runOps);
		const underNeon = await withDb('neon', runOps);
		expect(underNeon).toEqual(underPg);

		// And pin the absolute outcome, so "identical" can never mean "identically wrong".
		expect(underPg.inserted).toHaveLength(1);
		expect(underPg.inserted[0].slug).toBe('parity-a1');
		expect(underPg.joined).toEqual([
			{ article: 'parity-a1', pillar: 'parity-p1' },
			{ article: 'parity-a1', pillar: 'parity-p2' }
		]);
		expect(underPg.committed).toBe('parity-tx');
		expect(underPg.rollbackError).toBe('parity rollback probe');
		expect(underPg.afterRollback).toEqual([]); // the throw left no rows behind
	});

	it('honors statement_timeout on a neon connection exactly as pg does (unknown #1)', async () => {
		// pg sends statement_timeout in the startup packet; the neon path issues
		// a SET on connect because PgBouncer rejects non-allowlisted startup
		// parameters. Both must end up with the SAME effective value, and a
		// query exceeding it must actually be cancelled server-side.
		const config = { ...DB_POOL_DEFAULTS, statementTimeoutMillis: 100 };
		const probe = async (db: Db) => {
			const shown = await db.execute(sql`show statement_timeout`);
			const cancelled = await rejectionText(db.execute(sql`select pg_sleep(2)`));
			return { effective: shown.rows[0], cancelled: /statement timeout/i.test(cancelled) };
		};
		const underPg = await withDb('pg', probe, config);
		const underNeon = await withDb('neon', probe, config);
		expect(underNeon).toEqual(underPg);
		expect(underNeon).toEqual({ effective: { statement_timeout: '100ms' }, cancelled: true });
	});

	it('lands eight parallel writes through the 1-connection neon client (no hang)', async () => {
		await withDb(
			'neon',
			async (db) => {
				await Promise.all(
					Array.from({ length: 8 }, (_, i) =>
						db.insert(articles).values(articleValues(`parity-c${i}`, `C${i}`))
					)
				);
				const landed = await db
					.select({ id: articles.id })
					.from(articles)
					.where(like(articles.id, 'parity-c%'));
				expect(landed).toHaveLength(8);
				await db.delete(articles);
			},
			{ ...DB_POOL_DEFAULTS, max: 1 }
		);
	}, 10_000);

	it('queues two parallel interactive transactions on the single connection — both commit, no deadlock', async () => {
		// The neon driver defaults to one connection per instance
		// (NEON_POOL_MAX_DEFAULT). Two concurrent transactions therefore cannot
		// interleave: the second checkout waits for the first to release. The
		// wait is bounded by connectionTimeoutMillis — under load this sheds
		// rather than hangs. See DEPLOYMENT.md §12.
		await withDb(
			'neon',
			async (db) => {
				const runTx = (n: number) =>
					db.transaction(async (tx) => {
						await tx.insert(articles).values(articleValues(`parity-t${n}`, `T${n}`));
						await tx.execute(sql`select pg_sleep(0.05)`);
					});
				await Promise.all([runTx(1), runTx(2)]);
				const landed = await db
					.select({ id: articles.id })
					.from(articles)
					.where(like(articles.id, 'parity-t%'))
					.orderBy(asc(articles.id));
				expect(landed).toEqual([{ id: 'parity-t1' }, { id: 'parity-t2' }]);
				await db.delete(articles);
			},
			{ ...DB_POOL_DEFAULTS, max: 1 }
		);
	}, 10_000);
});
