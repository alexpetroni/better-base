import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../db/client.ts';
import { loginAttempts } from '../modules/auth/schema.ts';
import { chatRateLimits, chatSessions } from '../modules/chat/schema.ts';
import { subscribers } from '../modules/crm/schema.ts';
import { nurtureEnrollments, nurtureSends, nurtureSequences } from '../modules/nurture/schema.ts';
import { pendingRefunds } from '../modules/shop/schema.ts';
import { processedEvents } from './event-ledger/schema.ts';
import { rateLimits } from './rate-limit/schema.ts';
import { formatRetentionSweep, runRetentionSweep } from './retention.ts';

// Integration against the compose Postgres: the sweep spans three counter
// tables plus chat sessions, so it is only meaningful against a real schema.
// Both the `pnpm chat:prune` script and /api/cron/chat-prune call this.

let db: Db;
const NOW = new Date('2026-03-02T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('runRetentionSweep', () => {
	it('deletes only the expired rows across every counter table', async () => {
		await db.insert(chatSessions).values([
			{ id: 'sweep-old', anonymousToken: 'sweep-old-token', createdAt: daysAgo(31) },
			{ id: 'sweep-fresh', anonymousToken: 'sweep-fresh-token', createdAt: daysAgo(1) }
		]);
		await db.insert(chatRateLimits).values([
			{ key: 'ip:sweep-old', count: 3, windowStartedAt: daysAgo(31) },
			{ key: 'ip:sweep-fresh', count: 1, windowStartedAt: daysAgo(1) }
		]);
		await db.insert(rateLimits).values([
			{ key: 'newsletter:ip:sweep-old', count: 2, windowStartedAt: daysAgo(31) },
			{ key: 'newsletter:ip:sweep-fresh', count: 1, windowStartedAt: daysAgo(1) }
		]);
		await db.insert(loginAttempts).values([
			{ key: 'login:sweep-old', count: 9, windowStartedAt: daysAgo(31) },
			{ key: 'login:sweep-fresh', count: 1, windowStartedAt: daysAgo(1) }
		]);
		// The event ledger keeps rows well past Stripe's redelivery window (90
		// days) — a 31-day-old row must SURVIVE the sweep that takes the
		// 30-day counters above.
		await db.insert(processedEvents).values([
			{
				provider: 'stripe',
				eventId: 'evt-expired',
				eventType: 't',
				outcome: 'ok',
				receivedAt: daysAgo(91)
			},
			{
				provider: 'stripe',
				eventId: 'evt-aging',
				eventType: 't',
				outcome: 'ok',
				receivedAt: daysAgo(31)
			},
			{
				provider: 'stripe',
				eventId: 'evt-fresh',
				eventType: 't',
				outcome: 'ok',
				receivedAt: daysAgo(1)
			}
		]);

		// Refund-before-order rows (FIX-10): a MATCHED row past the ledger window
		// is swept; a fresh matched one and an UNMATCHED old one (a refund whose
		// order never came — the operator's signal) both survive.
		await db.insert(pendingRefunds).values([
			{
				paymentIntent: 'pi-matched-expired',
				chargeId: 'ch-1',
				amountCents: 4990,
				amountRefundedCents: 4990,
				receivedAt: daysAgo(120),
				matchedAt: daysAgo(91)
			},
			{
				paymentIntent: 'pi-matched-fresh',
				chargeId: 'ch-2',
				amountCents: 4990,
				amountRefundedCents: 4990,
				receivedAt: daysAgo(3),
				matchedAt: daysAgo(1)
			},
			{
				paymentIntent: 'pi-unmatched-old',
				chargeId: 'ch-3',
				amountCents: 4990,
				amountRefundedCents: 4990,
				receivedAt: daysAgo(200),
				matchedAt: null
			}
		]);

		// Nurture: only CLOSED enrollments past the 180-day window are swept —
		// an old-but-active enrollment still has future sends to deliver.
		await db.insert(nurtureSequences).values({
			id: 'sweep-seq',
			key: 'sweep-seq',
			name: 'Sweep',
			trigger: { kind: 'consent-confirmed' },
			steps: []
		});
		await db.insert(subscribers).values([
			{ id: 'sweep-sub-a', email: 'sweep-a@example.ro', unsubscribeToken: 'sweep-sub-a-token' },
			{ id: 'sweep-sub-b', email: 'sweep-b@example.ro', unsubscribeToken: 'sweep-sub-b-token' }
		]);
		await db.insert(nurtureEnrollments).values([
			{
				id: 'enr-expired',
				sequenceId: 'sweep-seq',
				subscriberId: 'sweep-sub-a',
				status: 'completed',
				enrolledAt: daysAgo(200),
				closedAt: daysAgo(181)
			},
			{
				id: 'enr-active-old',
				sequenceId: 'sweep-seq',
				subscriberId: 'sweep-sub-b',
				status: 'active',
				enrolledAt: daysAgo(200)
			}
		]);
		await db.insert(nurtureSends).values({
			id: 'send-expired',
			enrollmentId: 'enr-expired',
			stepIndex: 0,
			scheduledAt: daysAgo(200),
			status: 'sent'
		});

		const result = await runRetentionSweep(db, NOW);

		expect(result).toMatchObject({
			sessions: 1,
			chatRateLimitRows: 1,
			publicEmailRateLimitRows: 1,
			loginRateLimitRows: 1,
			processedEventRows: 1,
			pendingRefundRows: 1,
			nurtureEnrollmentRows: 1,
			retentionDays: 30,
			ledgerRetentionDays: 90,
			nurtureRetentionDays: 180
		});
		// The fresh row of every table survives — a sweep that took live
		// counters would reset limits for anyone currently being throttled.
		expect((await db.select().from(chatSessions)).map((r) => r.id)).toEqual(['sweep-fresh']);
		expect((await db.select().from(pendingRefunds)).map((r) => r.paymentIntent).sort()).toEqual([
			'pi-matched-fresh',
			'pi-unmatched-old'
		]);
		expect((await db.select().from(chatRateLimits)).map((r) => r.key)).toEqual(['ip:sweep-fresh']);
		expect((await db.select().from(rateLimits)).map((r) => r.key)).toEqual([
			'newsletter:ip:sweep-fresh'
		]);
		expect((await db.select().from(loginAttempts)).map((r) => r.key)).toEqual([
			'login:sweep-fresh'
		]);
		expect((await db.select().from(processedEvents)).map((r) => r.eventId).sort()).toEqual([
			'evt-aging',
			'evt-fresh'
		]);
		// The expired enrollment took its send rows with it (cascade); the old
		// but still-active enrollment survives.
		expect((await db.select().from(nurtureEnrollments)).map((r) => r.id)).toEqual([
			'enr-active-old'
		]);
		expect(await db.select().from(nurtureSends)).toEqual([]);
	});

	it('is a no-op on a swept database', async () => {
		const result = await runRetentionSweep(db, NOW);
		expect(result).toMatchObject({
			sessions: 0,
			chatRateLimitRows: 0,
			publicEmailRateLimitRows: 0,
			loginRateLimitRows: 0,
			processedEventRows: 0
		});
	});

	it('summarizes counts in one line', () => {
		const line = formatRetentionSweep({
			sessions: 2,
			chatRateLimitRows: 3,
			publicEmailRateLimitRows: 4,
			loginRateLimitRows: 5,
			processedEventRows: 6,
			pendingRefundRows: 8,
			nurtureEnrollmentRows: 7,
			retentionDays: 30,
			ledgerRetentionDays: 90,
			nurtureRetentionDays: 180
		});
		expect(line).toContain('2 session(s) older than 30 days');
		expect(line).toContain('3 chat / 4 public-email / 5 login');
		expect(line).toContain('6 processed-event row(s) older than 90 days');
		expect(line).toContain('8 matched pending-refund row(s) past the same window');
		expect(line).toContain('7 closed nurture enrollment(s) older than 180 days');
	});
});
