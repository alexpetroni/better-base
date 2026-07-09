import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { users } from '../modules/auth/schema.ts';
import { subscribers } from '../modules/crm/schema.ts';
import { createDb, type Db } from './client.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh): the FIX-5 data-integrity guarantees — covering indexes on every
// previously-unindexed FK/lookup column (audit Theme E) and DB-level
// case-insensitive email uniqueness (audit data LOW-2). All of these FAIL on a
// database migrated only through 0010.
let db: Db;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle')
	});
});

afterAll(async () => {
	await db.$client.end();
});

/** Postgres duplicate-key violation. */
function isUniqueViolation(err: unknown): boolean {
	for (let cause = err; cause instanceof Error; cause = cause.cause) {
		if ((cause as { code?: string }).code === '23505') return true;
	}
	return false;
}

describe('FK / lookup covering indexes (audit Theme E)', () => {
	const EXPECTED: Array<[table: string, index: string]> = [
		['quizzes', 'quizzes_pillar_id_idx'],
		['quizzes', 'quizzes_created_by_idx'],
		['quiz_results', 'quiz_results_subscriber_id_idx'],
		['orders', 'orders_email_idx'],
		['orders', 'orders_stripe_payment_intent_idx'],
		['order_items', 'order_items_product_id_idx'],
		['articles', 'articles_cover_media_id_idx'],
		['articles', 'articles_created_by_idx'],
		['products', 'products_cover_media_id_idx'],
		['media', 'media_created_by_idx']
	];

	it.each(EXPECTED)('%s has index %s', async (table, index) => {
		const result = await db.execute(sql`
			select indexname from pg_indexes
			where schemaname = 'public' and tablename = ${table} and indexname = ${index}
		`);
		expect(result.rows).toHaveLength(1);
	});

	it('the refund-webhook lookup (orders by stripe_payment_intent) can use its index', async () => {
		// enable_seqscan=off forces the planner to prove the index fits the query
		// shape — with a seq scan forbidden, a missing/unusable index would still
		// plan a (penalized) seq scan.
		await db.execute(sql`set enable_seqscan = off`);
		try {
			const plan = await db.execute(
				sql`explain (format json) select * from orders where stripe_payment_intent = 'pi_x'`
			);
			const planText = JSON.stringify(plan.rows);
			expect(planText).toContain('orders_stripe_payment_intent_idx');
		} finally {
			await db.execute(sql`set enable_seqscan = on`);
		}
	});

	it('the public quiz-by-pillar lookup can use its index', async () => {
		await db.execute(sql`set enable_seqscan = off`);
		try {
			const plan = await db.execute(
				sql`explain (format json) select * from quizzes where pillar_id = 1`
			);
			expect(JSON.stringify(plan.rows)).toContain('quizzes_pillar_id_idx');
		} finally {
			await db.execute(sql`set enable_seqscan = on`);
		}
	});
});

describe('case-insensitive email uniqueness (audit data LOW-2)', () => {
	it('rejects a subscriber differing only in case, even from a writer that skips normalizeEmail', async () => {
		await db.insert(subscribers).values({
			id: crypto.randomUUID(),
			email: 'casetest@example.com',
			unsubscribeToken: crypto.randomUUID()
		});
		await expect(
			db.insert(subscribers).values({
				id: crypto.randomUUID(),
				email: 'CaseTest@Example.com',
				unsubscribeToken: crypto.randomUUID()
			})
		).rejects.toSatisfy(isUniqueViolation);
	});

	it('rejects a user differing only in case', async () => {
		await db.insert(users).values({
			id: crypto.randomUUID(),
			name: 'Case Test',
			email: 'staff-case@example.com'
		});
		await expect(
			db.insert(users).values({
				id: crypto.randomUUID(),
				name: 'Case Test 2',
				email: 'Staff-Case@example.com'
			})
		).rejects.toSatisfy(isUniqueViolation);
	});
});
