import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { runOnce } from './core.ts';
import { processedEvents } from './schema.ts';

// Integration against the compose Postgres: runOnce's guarantees are
// transactional semantics, so only a real database can prove them.

let db: Db;

const entry = (eventId: string) => ({ provider: 'test', eventId, eventType: 'unit.test' });

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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('runOnce', () => {
	it('runs the effect on first delivery and records its outcome', async () => {
		let runs = 0;
		const result = await runOnce(db, entry('evt-first'), async () => {
			runs += 1;
			return { outcome: 'did-the-thing', value: 42 };
		});
		expect(result).toEqual({ duplicate: false, outcome: 'did-the-thing', value: 42 });
		expect(runs).toBe(1);

		const [row] = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, 'evt-first'));
		expect(row).toMatchObject({
			provider: 'test',
			eventType: 'unit.test',
			outcome: 'did-the-thing'
		});
	});

	it('skips the effect on redelivery and reports the recorded outcome', async () => {
		await runOnce(db, entry('evt-again'), async () => ({ outcome: 'first-run', value: null }));
		let reran = false;
		const second = await runOnce(db, entry('evt-again'), async () => {
			reran = true;
			return { outcome: 'second-run', value: null };
		});
		expect(second).toEqual({ duplicate: true, outcome: 'first-run' });
		expect(reran).toBe(false);
	});

	it('the same event id under another provider is a different event', async () => {
		await runOnce(db, { ...entry('evt-shared'), provider: 'a' }, async () => ({
			outcome: 'a-ran',
			value: null
		}));
		const other = await runOnce(db, { ...entry('evt-shared'), provider: 'b' }, async () => ({
			outcome: 'b-ran',
			value: null
		}));
		expect(other).toEqual({ duplicate: false, outcome: 'b-ran', value: null });
	});

	it('a throwing effect rolls back the claim AND the effect (poisoned events stay retryable)', async () => {
		await expect(
			runOnce(db, entry('evt-poison'), async (tx) => {
				// A partial write that must not survive the rollback.
				await tx.insert(processedEvents).values({
					provider: 'test',
					eventId: 'evt-poison-side-effect',
					eventType: 'unit.test',
					outcome: 'partial'
				});
				throw new Error('effect exploded');
			})
		).rejects.toThrow('effect exploded');

		// Neither the claim nor the partial write survived …
		expect(
			await db.select().from(processedEvents).where(eq(processedEvents.eventId, 'evt-poison'))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(processedEvents)
				.where(eq(processedEvents.eventId, 'evt-poison-side-effect'))
		).toHaveLength(0);

		// … so the retry runs the effect for real.
		const retry = await runOnce(db, entry('evt-poison'), async () => ({
			outcome: 'recovered',
			value: null
		}));
		expect(retry).toEqual({ duplicate: false, outcome: 'recovered', value: null });
	});

	it('concurrent deliveries serialize on the claim: exactly one effect run', async () => {
		let runs = 0;
		const results = await Promise.all(
			[1, 2, 3].map(() =>
				runOnce(db, entry('evt-concurrent'), async () => {
					runs += 1;
					return { outcome: 'won', value: null };
				})
			)
		);
		expect(runs).toBe(1);
		expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
		expect(results.filter((r) => r.duplicate)).toHaveLength(2);
		for (const r of results) expect(r.outcome).toBe('won');
	});
});
