import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { subscribers } from '../crm/schema.ts';
import { emailLog } from '../email/schema.ts';
import { quizResults, quizzes } from '../quiz/schema.ts';
import { orders } from '../shop/schema.ts';
import { ANONYMIZED_EMAIL, eraseSubscriberData } from './erase.ts';

// Integration: the GDPR erasure behind `pnpm subscriber:delete` — subscriber
// row gone, quiz results kept but unlinked, orders/email log anonymized.

const EMAIL = 'gdpr-spec@example.com';

let db: Db;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });

	await db.insert(subscribers).values({
		id: 'gdpr-sub',
		email: EMAIL,
		consents: { newsletter: { granted: true, at: '2026-07-01T00:00:00Z', source: 'test' } },
		unsubscribeToken: 'gdpr-spec-token'
	});
	await db.insert(quizzes).values({ id: 'gdpr-quiz', slug: 'gdpr-quiz', title: 'Q' });
	await db.insert(quizResults).values({
		id: 'gdpr-result',
		quizId: 'gdpr-quiz',
		subscriberId: 'gdpr-sub',
		answers: [],
		score: 10,
		profile: {
			score: 10,
			maxScore: 32,
			band: { key: 'ok', min: 0, label: 'ok', advice: '' },
			dimensions: []
		}
	});
	await db.insert(orders).values({
		id: 'gdpr-order',
		email: EMAIL,
		stripeSessionId: 'cs_test_gdpr',
		amountTotalCents: 4990,
		currency: 'ron',
		status: 'paid',
		shippingAddress: { name: 'Test Person', line1: 'Str. Exemplu 1', city: 'București' }
	});
	await db.insert(emailLog).values({
		id: 'gdpr-log',
		idempotencyKey: 'gdpr-spec-key',
		toEmail: EMAIL,
		template: 'newsletter-confirm',
		subject: 'Confirmă',
		data: { name: 'Test Person', confirmUrl: 'https://example.com/t0k3n' },
		status: 'dryrun'
	});
});

afterAll(async () => {
	await db?.$client.end();
});

describe('eraseSubscriberData', () => {
	it('rejects invalid emails', async () => {
		expect(await eraseSubscriberData({ db }, 'not-an-email')).toEqual({
			ok: false,
			error: 'invalid-email'
		});
	});

	it('deletes the subscriber and anonymizes every trace', async () => {
		// normalizeEmail must make the lookup case/whitespace-insensitive.
		const result = await eraseSubscriberData({ db }, `  ${EMAIL.toUpperCase()} `);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({
			subscriberDeleted: true,
			quizResultsUnlinked: 1,
			ordersAnonymized: 1,
			emailLogAnonymized: 1
		});

		expect(await db.select().from(subscribers).where(eq(subscribers.email, EMAIL))).toHaveLength(0);

		// The quiz result survives as anonymous statistics.
		const [quizResult] = await db
			.select()
			.from(quizResults)
			.where(eq(quizResults.id, 'gdpr-result'));
		expect(quizResult.subscriberId).toBeNull();
		expect(quizResult.score).toBe(10);

		// The order survives (accounting) but carries no personal data.
		const [order] = await db.select().from(orders).where(eq(orders.id, 'gdpr-order'));
		expect(order.email).toBe(ANONYMIZED_EMAIL);
		expect(order.shippingAddress).toBeNull();
		expect(order.status).toBe('paid');

		const [log] = await db.select().from(emailLog).where(eq(emailLog.id, 'gdpr-log'));
		expect(log.toEmail).toBe(ANONYMIZED_EMAIL);
		expect(log.data).toEqual({});
		expect(log.idempotencyKey).toBe('gdpr-spec-key');
	});

	it('is safe to repeat: reports nothing left to erase', async () => {
		const result = await eraseSubscriberData({ db }, EMAIL);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({
			subscriberDeleted: false,
			quizResultsUnlinked: 0,
			ordersAnonymized: 0,
			emailLogAnonymized: 0
		});
	});
});
