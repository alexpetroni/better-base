import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../db/client.ts';
import { loginAttempts } from '../modules/auth/schema.ts';
import { chatMessages, chatRateLimits, chatSessions } from '../modules/chat/schema.ts';
import { pruneChatSessions } from '../modules/chat/service.ts';
import { subscribers } from '../modules/crm/schema.ts';
import { nurtureEnrollments, nurtureSends, nurtureSequences } from '../modules/nurture/schema.ts';
import { pruneNurtureEnrollments } from '../modules/nurture/service.ts';
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
			nurtureRetentionDays: 180,
			failures: []
		});
		expect(line).toContain('2 session(s) older than 30 days');
		expect(line).toContain('3 chat / 4 public-email / 5 login');
		expect(line).toContain('6 processed-event row(s) older than 90 days');
		expect(line).toContain('8 matched pending-refund row(s) past the same window');
		expect(line).toContain('7 closed nurture enrollment(s) older than 180 days');
	});
});

// FIX-14 (audit 2026-09-03 "Chat"): the sweep deleted in one statement that
// could never finish inside statement_timeout on a large table, and one
// failing pruner aborted every later one.
describe('runRetentionSweep batching and isolation (FIX-14)', () => {
	it('prunes 12 000 expired chat sessions in batches and completes', async () => {
		const TOTAL = 12_000;
		for (let start = 0; start < TOTAL; start += 2_000) {
			await db.insert(chatSessions).values(
				Array.from({ length: 2_000 }, (_, i) => ({
					id: `bulk-${start + i}`,
					anonymousToken: `bulk-${start + i}-token`,
					createdAt: daysAgo(40)
				}))
			);
		}
		await db.insert(chatSessions).values({
			id: 'bulk-fresh',
			anonymousToken: 'bulk-fresh-token',
			createdAt: daysAgo(1)
		});
		await db.insert(chatMessages).values({
			id: 'bulk-msg',
			sessionId: 'bulk-0',
			role: 'user',
			content: 'cascade me'
		});

		const countExpired = async () =>
			(
				await db
					.select({ n: sql<number>`count(*)::int` })
					.from(chatSessions)
					.where(sql`${chatSessions.createdAt} < ${daysAgo(30)}`)
			)[0].n;
		const expiredBefore = await countExpired();
		expect(expiredBefore).toBeGreaterThanOrEqual(TOTAL);

		// A single LIMIT-bounded DELETE would return 5000 here; only a loop
		// reaches the full count.
		const result = await pruneChatSessions(db, NOW);
		expect(result.sessions).toBe(expiredBefore);
		expect(await countExpired()).toBe(0);
		expect(
			await db
				.select()
				.from(chatSessions)
				.where(sql`id = 'bulk-fresh'`)
		).toHaveLength(1);
		expect(await db.select().from(chatMessages)).toEqual([]);
	}, 60_000);

	it('prunes closed nurture enrollments in batches (loop past the first LIMIT)', async () => {
		await db.insert(nurtureSequences).values({
			id: 'batch-seq',
			key: 'batch-seq',
			name: 'Batch',
			trigger: { kind: 'consent-confirmed' },
			steps: []
		});
		await db.insert(subscribers).values(
			Array.from({ length: 5 }, (_, i) => ({
				id: `batch-sub-${i}`,
				email: `batch-${i}@example.ro`,
				unsubscribeToken: `batch-sub-${i}-token`
			}))
		);
		await db.insert(nurtureEnrollments).values(
			Array.from({ length: 5 }, (_, i) => ({
				id: `batch-enr-${i}`,
				sequenceId: 'batch-seq',
				subscriberId: `batch-sub-${i}`,
				status: 'completed' as const,
				enrolledAt: daysAgo(400),
				closedAt: daysAgo(390)
			}))
		);
		expect(await pruneNurtureEnrollments(db, daysAgo(181), 2)).toBe(5);
		expect(
			await db
				.select()
				.from(nurtureEnrollments)
				.where(sql`id like 'batch-enr-%'`)
		).toEqual([]);
	});

	it('a failing pruner is reported and does not prevent the others from running', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await db.insert(chatSessions).values({
			id: 'iso-old',
			anonymousToken: 'iso-old-token',
			createdAt: daysAgo(31)
		});
		await db.insert(subscribers).values({
			id: 'iso-sub',
			email: 'iso@example.ro',
			unsubscribeToken: 'iso-sub-token'
		});
		await db.insert(nurtureEnrollments).values({
			id: 'iso-enr',
			sequenceId: 'batch-seq',
			subscriberId: 'iso-sub',
			status: 'cancelled',
			enrolledAt: daysAgo(200),
			closedAt: daysAgo(181)
		});

		const result = await runRetentionSweep(db, NOW, {
			pruneProcessedEvents: async () => {
				throw new Error('ledger prune boom');
			}
		});
		expect(result).toMatchObject({
			sessions: 1,
			nurtureEnrollmentRows: 1,
			processedEventRows: 0,
			failures: [{ step: 'processedEventRows', message: 'ledger prune boom' }]
		});
		expect(
			await db
				.select()
				.from(chatSessions)
				.where(sql`id = 'iso-old'`)
		).toEqual([]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(String(errorSpy.mock.calls[0][0])).toMatch(/processedEventRows.*ledger prune boom/);
		expect(formatRetentionSweep(result)).toMatch(/FAILED.*processedEventRows/);
		errorSpy.mockRestore();
	});
});
