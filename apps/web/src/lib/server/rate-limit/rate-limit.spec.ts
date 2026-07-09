import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { consumeRateLimit, type RateLimitConfig } from './core.ts';
import { consumePublicEmailBudget } from './public-email.ts';
import { rateLimits } from './schema.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh) — proves the upsert is atomic against a REAL database, not a mock.
let db: Db;

const CONFIG: RateLimitConfig = { max: 5, windowMs: 15 * 60 * 1000 };
// Fixed, window-aligned base time: every consume passes `now` explicitly, so
// the assertions are deterministic regardless of when the suite runs.
const W0 = new Date('2026-03-02T10:00:00Z');
const at = (ms: number) => new Date(W0.getTime() + ms);

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

describe('consumeRateLimit (atomic sliding window, real db)', () => {
	it('never loses increments under parallel fire and admits exactly max', async () => {
		const key = 'core:race';
		const results = await Promise.all(
			Array.from({ length: 30 }, () => consumeRateLimit(db, rateLimits, key, CONFIG, at(1000)))
		);
		// Every request saw a distinct post-increment count: 1..30, no lost writes.
		const counts = results.map((r) => r.count).sort((a, b) => a - b);
		expect(counts).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
		expect(results.filter((r) => !r.limited)).toHaveLength(CONFIG.max);

		const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key));
		expect(row.count).toBe(30);
	});

	it('resets the window in SQL after a gap of two windows', async () => {
		const key = 'core:reset';
		for (let i = 0; i < CONFIG.max; i++) {
			await consumeRateLimit(db, rateLimits, key, CONFIG, at(1000));
		}
		const fresh = await consumeRateLimit(
			db,
			rateLimits,
			key,
			CONFIG,
			at(2 * CONFIG.windowMs + 1000)
		);
		expect(fresh).toEqual({ count: 1, prevCount: 0, limited: false });
	});

	it('closes the boundary burst: a cap filled late in one window still blocks just after it', async () => {
		const key = 'core:boundary';
		for (let i = 0; i < CONFIG.max; i++) {
			await consumeRateLimit(db, rateLimits, key, CONFIG, at(CONFIG.windowMs - 1000));
		}
		// Fixed window would admit 5 more here; the sliding window refuses.
		const burst = await consumeRateLimit(db, rateLimits, key, CONFIG, at(CONFIG.windowMs + 1000));
		expect(burst.limited).toBe(true);
		expect(burst).toMatchObject({ count: 1, prevCount: CONFIG.max });

		// Halfway into the next window the previous one has decayed enough.
		const later = await consumeRateLimit(
			db,
			rateLimits,
			key,
			CONFIG,
			at(CONFIG.windowMs + 0.5 * CONFIG.windowMs)
		);
		expect(later.limited).toBe(false);
	});
});

describe('consumePublicEmailBudget', () => {
	const LIMITS = { windowMs: 60 * 60 * 1000 };

	it('caps sends per IP', async () => {
		const limits = { ip: { max: 3, ...LIMITS }, global: { max: 100, ...LIMITS } };
		const ip = '203.0.113.10';
		for (let i = 0; i < 3; i++) {
			const r = await consumePublicEmailBudget(db, 'newsletter', ip, at(1000), limits);
			expect(r.limited).toBe(false);
		}
		const blocked = await consumePublicEmailBudget(db, 'newsletter', ip, at(1000), limits);
		expect(blocked.limited).toBe(true);
		// Another visitor is unaffected by that IP's exhaustion.
		const other = await consumePublicEmailBudget(
			db,
			'newsletter',
			'203.0.113.11',
			at(1000),
			limits
		);
		expect(other.limited).toBe(false);
	});

	it('trips the global cap across distinct IPs (mailbomb via many victims)', async () => {
		const limits = { ip: { max: 100, ...LIMITS }, global: { max: 5, ...LIMITS } };
		for (let i = 0; i < 4; i++) {
			const r = await consumePublicEmailBudget(
				db,
				'quiz-email',
				`198.51.100.${i}`,
				at(1000),
				limits
			);
			expect(r.limited).toBe(false);
		}
		const fifth = await consumePublicEmailBudget(
			db,
			'quiz-email',
			'198.51.100.50',
			at(1000),
			limits
		);
		expect(fifth.limited).toBe(false);
		const sixth = await consumePublicEmailBudget(
			db,
			'quiz-email',
			'198.51.100.60',
			at(1000),
			limits
		);
		expect(sixth.limited).toBe(true);
	});
});
