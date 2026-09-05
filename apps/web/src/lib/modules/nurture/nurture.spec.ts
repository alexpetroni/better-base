import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { subscribers } from '../crm/schema.ts';
import { emailLog } from '../email/schema.ts';
import { createResendTransport } from '../email/resend.ts';
import { createEmailSender, type EmailSender } from '../email/service.ts';
import { quizResults, quizzes } from '../quiz/schema.ts';
import { drainNurtureSends, type NurtureDrainDeps } from './drain.ts';
import type { NurtureSequenceDefinition, SequenceStep, SequenceTrigger } from './definition.ts';
import { computeStepScheduledAt, NURTURE_SEND_PACE_MS } from './schedule.ts';
import { nurtureEnrollments, nurtureSends, nurtureSequences } from './schema.ts';
import {
	cancelSubscriberNurture,
	enrollFromOrderEmail,
	enrollFromQuizResult,
	enrollOnConsentConfirmed,
	listParkedSends,
	listSequencesWithStats,
	pruneNurtureEnrollments,
	retryParkedSend,
	seedNurtureSequences,
	setSequenceActive,
	stepsHash
} from './service.ts';

// Integration spec for the nurture queue against the compose Postgres:
// consent-gated enrollment, once-per-sequence, the claim-then-send drain
// under real concurrency, retry/backoff/parking, and the withdrawal paths.

// The unsubscribe end-to-end test imports the REAL route module, which reads
// getDb() — point it at the test database ($env is a build-time snapshot
// under vitest, so the mock is the seam).
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../db/index.ts')>();
	const { createDb: create } = await import('../../db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
let email: EmailSender;
const NOW = new Date('2026-02-10T10:00:00Z');
const minutes = (n: number) => n * 60 * 1000;
let seq = 0;

const drainDeps = (over: Partial<NurtureDrainDeps> = {}): NurtureDrainDeps => ({
	db,
	email,
	siteName: 'Better Sleep',
	baseUrl: 'https://example.ro',
	...over
});

async function makeSubscriber(
	opts: { consent?: boolean; confirmed?: boolean; email?: string } = {}
) {
	const { consent = true, confirmed = true } = opts;
	seq += 1;
	const [row] = await db
		.insert(subscribers)
		.values({
			id: `nur-sub-${seq}`,
			email: opts.email ?? `nur-sub-${seq}@example.ro`,
			consents: consent
				? { newsletter: { granted: true, at: NOW.toISOString(), source: 'test' } }
				: {},
			confirmedAt: confirmed ? NOW : null,
			unsubscribeToken: `nur-unsub-${seq}`
		})
		.returning();
	return row;
}

const TWO_STEPS: SequenceStep[] = [
	{ offsetDays: 0, templateKey: 'nurture', subject: 'Pas 1', paragraphs: ['Unu.'] },
	{ offsetDays: 3, hourLocal: 9, templateKey: 'nurture', subject: 'Pas 2', paragraphs: ['Doi.'] }
];

async function makeSequence(
	opts: { trigger?: SequenceTrigger; steps?: SequenceStep[]; active?: boolean } = {}
) {
	seq += 1;
	const [row] = await db
		.insert(nurtureSequences)
		.values({
			id: `nur-seq-${seq}`,
			key: `nur-seq-${seq}`,
			name: `Secvența ${seq}`,
			trigger: opts.trigger ?? { kind: 'consent-confirmed' },
			consentKey: 'newsletter',
			steps: opts.steps ?? TWO_STEPS,
			active: opts.active ?? true
		})
		.returning();
	return row;
}

async function sendsOf(enrollmentId: string) {
	return db
		.select()
		.from(nurtureSends)
		.where(eq(nurtureSends.enrollmentId, enrollmentId))
		.orderBy(nurtureSends.stepIndex);
}

async function enrollmentsOf(subscriberId: string) {
	return db
		.select()
		.from(nurtureEnrollments)
		.where(eq(nurtureEnrollments.subscriberId, subscriberId));
}

async function emailLogTo(address: string) {
	return db.select().from(emailLog).where(eq(emailLog.toEmail, address));
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	email = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
});

// Each test builds its own sequences; deactivating them afterwards keeps the
// shared tables from leaking enrollment targets into the next test (the
// enrollment paths and the drain only consider ACTIVE sequences).
afterEach(async () => {
	await db?.update(nurtureSequences).set({ active: false });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('enrollment (the GDPR gate)', () => {
	it('enrolls a confirmed subscriber with consent and materializes every step', async () => {
		const sequence = await makeSequence();
		const subscriber = await makeSubscriber();
		expect(await enrollOnConsentConfirmed({ db }, subscriber.id, NOW)).toBe(1);

		const [enrollment] = await enrollmentsOf(subscriber.id);
		expect(enrollment.status).toBe('active');
		expect(enrollment.sequenceId).toBe(sequence.id);
		const sends = await sendsOf(enrollment.id);
		expect(sends.map((s) => s.status)).toEqual(['pending', 'pending']);
		expect(sends[0].scheduledAt).toEqual(NOW);
		// Day+3 at 09:00 Bucharest (winter, +02) = 07:00Z.
		expect(sends[1].scheduledAt).toEqual(computeStepScheduledAt(NOW, TWO_STEPS[1]));
		expect(sends[1].scheduledAt).toEqual(new Date('2026-02-13T07:00:00Z'));
	});

	it('NEVER enrolls without granted consent or without double-opt-in confirmation', async () => {
		await makeSequence();
		const noConsent = await makeSubscriber({ consent: false, confirmed: true });
		const unconfirmed = await makeSubscriber({ consent: true, confirmed: false });
		expect(await enrollOnConsentConfirmed({ db }, noConsent.id, NOW)).toBe(0);
		expect(await enrollOnConsentConfirmed({ db }, unconfirmed.id, NOW)).toBe(0);
		expect(await enrollmentsOf(noConsent.id)).toEqual([]);
		expect(await enrollmentsOf(unconfirmed.id)).toEqual([]);
	});

	it('enrolls once per sequence, ever — a re-trigger is a no-op (the re-enrollment rule)', async () => {
		await makeSequence();
		const subscriber = await makeSubscriber();
		expect(await enrollOnConsentConfirmed({ db }, subscriber.id, NOW)).toBe(1);
		expect(await enrollOnConsentConfirmed({ db }, subscriber.id, NOW)).toBe(0);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		expect((await sendsOf(enrollment.id)).length).toBe(2);

		// Even after withdrawal + a fresh trigger: cancelled is still enrolled-once.
		await cancelSubscriberNurture({ db }, subscriber.id, NOW);
		expect(await enrollOnConsentConfirmed({ db }, subscriber.id, NOW)).toBe(0);
	});
});

describe('quiz and order triggers', () => {
	async function makeQuizResult(subscriberId: string | null, bandKey: string) {
		seq += 1;
		const slug = `nur-quiz-${seq}`;
		const [quiz] = await db
			.insert(quizzes)
			.values({ id: `nur-quiz-${seq}`, slug, title: 'Q', status: 'published' })
			.returning();
		const [result] = await db
			.insert(quizResults)
			.values({
				id: `nur-res-${seq}`,
				quizId: quiz.id,
				subscriberId,
				score: 5,
				profile: {
					score: 5,
					maxScore: 10,
					band: { key: bandKey, min: 0, label: 'Bandă', advice: 'Sfat' },
					dimensions: []
				}
			})
			.returning();
		return { slug, result };
	}

	it('band-filters quiz enrollment and refuses the unconfirmed, then back-fills on confirm', async () => {
		const confirmed = await makeSubscriber();
		const { slug, result } = await makeQuizResult(confirmed.id, 'ridicat');
		const matching = await makeSequence({
			trigger: { kind: 'quiz-completed', quizSlug: slug, bands: ['ridicat'] }
		});
		const otherBand = await makeSequence({
			trigger: { kind: 'quiz-completed', quizSlug: slug, bands: ['scazut'] }
		});
		expect(await enrollFromQuizResult({ db }, result.id, NOW)).toBe(1);
		const enrollments = await enrollmentsOf(confirmed.id);
		expect(enrollments.map((e) => e.sequenceId)).toEqual([matching.id]);
		expect(enrollments.map((e) => e.sequenceId)).not.toContain(otherBand.id);

		// The quiz → signup → confirm path: at claim time the subscriber is not
		// yet confirmed, so nothing happens; the confirm click back-fills.
		const pending = await makeSubscriber({ confirmed: false });
		const second = await makeQuizResult(pending.id, 'ridicat');
		const secondSeq = await makeSequence({
			trigger: { kind: 'quiz-completed', quizSlug: second.slug }
		});
		expect(await enrollFromQuizResult({ db }, second.result.id, NOW)).toBe(0);
		await db.update(subscribers).set({ confirmedAt: NOW }).where(eq(subscribers.id, pending.id));
		expect(await enrollOnConsentConfirmed({ db }, pending.id, NOW)).toBe(1);
		expect((await enrollmentsOf(pending.id)).map((e) => e.sequenceId)).toEqual([secondSeq.id]);
	});

	it('an unclaimed quiz result (no linked subscriber) enrolls nobody', async () => {
		const { result, slug } = await makeQuizResult(null, 'ridicat');
		await makeSequence({ trigger: { kind: 'quiz-completed', quizSlug: slug } });
		expect(await enrollFromQuizResult({ db }, result.id, NOW)).toBe(0);
	});

	it('order-paid enrolls the (mailable) subscriber once; later orders are no-ops', async () => {
		await makeSequence({ trigger: { kind: 'order-paid' } });
		const subscriber = await makeSubscriber();
		// The order email arrives as typed by the buyer — normalization matches it.
		expect(await enrollFromOrderEmail({ db }, subscriber.email.toUpperCase(), NOW)).toBe(1);
		expect(await enrollFromOrderEmail({ db }, subscriber.email, NOW)).toBe(0);
		// An order from an address that never subscribed enrolls nobody.
		expect(await enrollFromOrderEmail({ db }, `unknown-${seq}@example.ro`, NOW)).toBe(0);
	});
});

describe('drain: claim-then-send', () => {
	it('sends step 1 now and step 2 on schedule — and the no-consent subscriber receives NOTHING', async () => {
		await makeSequence();
		const subscriber = await makeSubscriber();
		const bystander = await makeSubscriber({ consent: false });
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		await enrollOnConsentConfirmed({ db }, bystander.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);

		// Time-travel via injected now: at enrollment, only step 1 is due.
		const first = await drainNurtureSends(drainDeps(), { now: NOW });
		expect(first).toMatchObject({ claimed: 1, sent: 1, parked: 0, cancelled: 0 });
		let sends = await sendsOf(enrollment.id);
		expect(sends.map((s) => s.status)).toEqual(['sent', 'pending']);

		// Nothing further due yet: a second run at the same instant is a no-op.
		expect((await drainNurtureSends(drainDeps(), { now: NOW })).claimed).toBe(0);

		// …but at the step-2 instant it goes out and the enrollment completes.
		const step2At = new Date('2026-02-13T07:00:00Z');
		const second = await drainNurtureSends(drainDeps(), { now: step2At });
		expect(second).toMatchObject({ claimed: 1, sent: 1, completed: 1 });
		sends = await sendsOf(enrollment.id);
		expect(sends.map((s) => s.status)).toEqual(['sent', 'sent']);
		const [closed] = await enrollmentsOf(subscriber.id);
		expect(closed.status).toBe('completed');
		expect(closed.closedAt).toEqual(step2At);

		// Both emails recorded (dry-run) with the derived idempotency keys…
		const delivered = await emailLogTo(subscriber.email);
		expect(delivered.map((row) => row.idempotencyKey).sort()).toEqual([
			`nurture:${enrollment.id}:0`,
			`nurture:${enrollment.id}:1`
		]);
		// …and the subscriber without consent received nothing, ever.
		expect(await emailLogTo(bystander.email)).toEqual([]);
	});

	it('two concurrent invocations over the same due batch send each email exactly once', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const enrolled = [];
		for (let i = 0; i < 6; i += 1) {
			const subscriber = await makeSubscriber();
			await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
			enrolled.push(subscriber);
		}

		// Real parallel promises against the same due batch — the FOR UPDATE
		// SKIP LOCKED claim must partition it, not duplicate it.
		const [a, b] = await Promise.all([
			drainNurtureSends(drainDeps(), { now: NOW }),
			drainNurtureSends(drainDeps(), { now: NOW })
		]);
		expect(a.sent + b.sent).toBe(6);

		for (const subscriber of enrolled) {
			const [enrollment] = await enrollmentsOf(subscriber.id);
			const sends = await sendsOf(enrollment.id);
			expect(sends.map((s) => s.status)).toEqual(['sent']);
			// One email_log row per key — the second layer never even engaged.
			expect((await emailLogTo(subscriber.email)).length).toBe(1);
		}
	});

	it('respects the per-invocation bound; a backlog drains over consecutive runs, oldest first', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		for (let i = 0; i < 5; i += 1) {
			const subscriber = await makeSubscriber();
			await enrollOnConsentConfirmed({ db }, subscriber.id, new Date(NOW.getTime() - minutes(i)));
		}
		const runs = [
			await drainNurtureSends(drainDeps(), { now: NOW, batchSize: 2 }),
			await drainNurtureSends(drainDeps(), { now: NOW, batchSize: 2 }),
			await drainNurtureSends(drainDeps(), { now: NOW, batchSize: 2 })
		];
		expect(runs.map((r) => r.sent)).toEqual([2, 2, 1]);
		expect((await drainNurtureSends(drainDeps(), { now: NOW, batchSize: 2 })).claimed).toBe(0);
	});

	it('a failed send retries with backoff and parks after the cap — visible to the operator', async () => {
		const failing = createEmailSender({
			db,
			dryRun: false,
			from: 'test@example.ro',
			transport: {
				send: async () => {
					throw new Error('smtp down');
				}
			}
		});
		const sequence = await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);

		// First failure: back to pending, 15 minutes out, error recorded.
		const first = await drainNurtureSends(drainDeps({ email: failing }), { now: NOW });
		expect(first).toMatchObject({ claimed: 1, retried: 1, parked: 0, sent: 0 });
		let [send] = await sendsOf(enrollment.id);
		expect(send.status).toBe('pending');
		expect(send.attempts).toBe(1);
		expect(send.scheduledAt).toEqual(new Date(NOW.getTime() + minutes(15)));
		expect(send.lastError).toContain('smtp down');

		// Not due before the backoff elapses.
		expect((await drainNurtureSends(drainDeps({ email: failing }), { now: NOW })).claimed).toBe(0);

		// At the cap the send parks as failed instead of looping forever…
		await db
			.update(nurtureSends)
			.set({ attempts: 4, scheduledAt: NOW })
			.where(eq(nurtureSends.id, send.id));
		const last = await drainNurtureSends(drainDeps({ email: failing }), { now: NOW });
		expect(last).toMatchObject({ claimed: 1, parked: 1 });
		[send] = await sendsOf(enrollment.id);
		expect(send.status).toBe('failed');
		expect(send.attempts).toBe(5);

		// …and is listed for operator attention.
		const parked = await listParkedSends({ db });
		expect(parked.map((p) => p.sendId)).toContain(send.id);
		const stats = await listSequencesWithStats({ db });
		expect(stats.find((s) => s.sequence.id === sequence.id)).toMatchObject({
			enrolled: 1,
			failedSends: 1,
			pendingSends: 0
		});
	});

	it('re-claims a stale `sending` row (crashed invocation) and the email key dedupes delivery', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		const [send] = await sendsOf(enrollment.id);

		// Simulate a crash AFTER delivery: the email went out (dry-run row
		// exists) but the invocation died before recording the outcome.
		await email.send({
			to: subscriber.email,
			template: 'nurture',
			data: {
				siteName: 'Better Sleep',
				subject: 'S',
				paragraphs: ['P'],
				unsubscribeUrl: 'https://example.ro/unsubscribe/x'
			},
			idempotencyKey: `nurture:${enrollment.id}:0`
		});
		await db
			.update(nurtureSends)
			.set({ status: 'sending', claimedAt: new Date(NOW.getTime() - minutes(16)), attempts: 1 })
			.where(eq(nurtureSends.id, send.id));

		// A fresh claim is NOT taken while the claim is younger than the stale
		// window…
		await db
			.update(nurtureSends)
			.set({ claimedAt: new Date(NOW.getTime() - minutes(5)) })
			.where(eq(nurtureSends.id, send.id));
		expect((await drainNurtureSends(drainDeps(), { now: NOW })).claimed).toBe(0);

		// …but a stale one is, and the retry resolves as sent WITHOUT a second
		// delivery (email.send reports `skipped`).
		await db
			.update(nurtureSends)
			.set({ claimedAt: new Date(NOW.getTime() - minutes(16)) })
			.where(eq(nurtureSends.id, send.id));
		const result = await drainNurtureSends(drainDeps(), { now: NOW });
		expect(result).toMatchObject({ claimed: 1, sent: 1 });
		expect((await emailLogTo(subscriber.email)).length).toBe(1);
	});

	// Audit 2026-09-03 P1: a 403/422 from Resend was retried 5× over ~21 h.
	it('a non-retryable transport error parks the send immediately, keeping the body', async () => {
		const rejecting = createEmailSender({
			db,
			dryRun: false,
			from: 'test@example.ro',
			transport: createResendTransport(
				're_key_not_real',
				(async () =>
					new Response('{"message":"recipient rejected"}', { status: 422 })) as typeof fetch
			)
		});
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);

		const result = await drainNurtureSends(drainDeps({ email: rejecting }), { now: NOW });
		expect(result).toMatchObject({ claimed: 1, parked: 1, retried: 0, sent: 0 });
		const [send] = await sendsOf(enrollment.id);
		expect(send.status).toBe('failed');
		expect(send.attempts).toBe(1);
		expect(send.lastError).toContain('recipient rejected');
		// A parked send keeps the enrollment open for the operator's retry.
		expect((await enrollmentsOf(subscriber.id))[0].status).toBe('active');
	});

	// Audit 2026-09-03 P1: 25 back-to-back sends vs Resend's 2 req/s.
	it('paces live sends inside a batch (NURTURE_SEND_PACE_MS between transport calls, none in dry run)', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		for (let i = 0; i < 3; i += 1) {
			const subscriber = await makeSubscriber();
			await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		}
		const live = createEmailSender({
			db,
			dryRun: false,
			from: 'test@example.ro',
			transport: { send: async () => ({ providerId: 'p' }) }
		});
		const pace = vi.fn(async () => {});
		const result = await drainNurtureSends(drainDeps({ email: live, pace }), { now: NOW });
		expect(result.sent).toBe(3);
		expect(pace).toHaveBeenCalledTimes(2);
		expect(pace).toHaveBeenCalledWith(NURTURE_SEND_PACE_MS);

		// Dry run touches no API: nothing to pace.
		for (let i = 0; i < 2; i += 1) {
			const subscriber = await makeSubscriber();
			await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		}
		const dryPace = vi.fn(async () => {});
		expect((await drainNurtureSends(drainDeps({ pace: dryPace }), { now: NOW })).sent).toBe(2);
		expect(dryPace).not.toHaveBeenCalled();
	});

	// Audit 2026-09-03 P1: the drain counted every `skipped` as sent. A crash
	// between the email_log `sending` claim and the transport left a log row
	// in flight; the stale-claim retry then came back `skipped` and the step
	// was recorded as delivered although nothing ever went out.
	it('reports `sent` only for rows the log shows as delivered — an in-flight log row is a retry, not a send', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		const [send] = await sendsOf(enrollment.id);

		// The previous invocation claimed the email_log key and died before the
		// transport answered: the log row is `sending` and still FRESH. (The
		// email sender's staleness window runs on the wall clock, not on the
		// drain's injected `now`, so the log row is stamped against Date.now().)
		await db.insert(emailLog).values({
			id: `nur-inflight-${enrollment.id}`,
			idempotencyKey: `nurture:${enrollment.id}:0`,
			toEmail: subscriber.email,
			template: 'nurture',
			subject: 'S',
			data: {},
			status: 'sending',
			createdAt: new Date(Date.now() - minutes(2)),
			updatedAt: new Date(Date.now() - minutes(2))
		});
		await db
			.update(nurtureSends)
			.set({ status: 'sending', claimedAt: new Date(NOW.getTime() - minutes(16)), attempts: 1 })
			.where(eq(nurtureSends.id, send.id));

		const result = await drainNurtureSends(drainDeps(), { now: NOW });
		expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
		let [after] = await sendsOf(enrollment.id);
		expect(after.status).toBe('pending');
		expect(after.sentAt).toBeNull();
		// Nothing was delivered, so the enrollment is still open.
		expect((await enrollmentsOf(subscriber.id))[0].status).toBe('active');

		// Once the log claim is stale the retry re-claims it and the step is
		// recorded as sent exactly when the log says so.
		await db
			.update(emailLog)
			.set({ updatedAt: new Date(Date.now() - minutes(11)) })
			.where(eq(emailLog.idempotencyKey, `nurture:${enrollment.id}:0`));
		await db.update(nurtureSends).set({ scheduledAt: NOW }).where(eq(nurtureSends.id, send.id));
		expect(await drainNurtureSends(drainDeps(), { now: NOW })).toMatchObject({
			claimed: 1,
			sent: 1
		});
		[after] = await sendsOf(enrollment.id);
		expect(after.status).toBe('sent');
		const [logged] = await emailLogTo(subscriber.email);
		expect(logged.status).toBe('dryrun');
	});

	it('deactivating a sequence pauses its queue without a deploy; reactivating resumes it', async () => {
		const sequence = await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);

		expect(await setSequenceActive({ db }, sequence.id, false, NOW)).toBe(true);
		expect((await drainNurtureSends(drainDeps(), { now: NOW })).claimed).toBe(0);

		await setSequenceActive({ db }, sequence.id, true, NOW);
		expect((await drainNurtureSends(drainDeps(), { now: NOW })).sent).toBe(1);
	});
});

describe('withdrawal stops everything', () => {
	it('consent withdrawal cancels every pending send across sequences immediately', async () => {
		await makeSequence();
		await makeSequence({ trigger: { kind: 'order-paid' } });
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		await enrollFromOrderEmail({ db }, subscriber.email, NOW);
		expect((await enrollmentsOf(subscriber.id)).length).toBe(2);

		const cancelled = await cancelSubscriberNurture({ db }, subscriber.id, NOW);
		expect(cancelled).toEqual({ enrollments: 2, sends: 4 });
		for (const enrollment of await enrollmentsOf(subscriber.id)) {
			expect(enrollment.status).toBe('cancelled');
			expect(enrollment.closedAt).toEqual(NOW);
			expect((await sendsOf(enrollment.id)).map((s) => s.status)).toEqual([
				'cancelled',
				'cancelled'
			]);
		}
		// Nothing to drain, now or at any later step time.
		const later = new Date('2026-03-01T10:00:00Z');
		expect(await drainNurtureSends(drainDeps(), { now: later })).toMatchObject({ claimed: 0 });
		expect(await emailLogTo(subscriber.email)).toEqual([]);
	});

	it('the drain re-checks the consent gate at send time (defense in depth)', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		// Consent vanishes WITHOUT the cancellation hook running (e.g. a direct
		// data fix): the send is claimed but must not go out.
		await db
			.update(subscribers)
			.set({
				consents: { newsletter: { granted: false, at: NOW.toISOString(), source: 'test' } }
			})
			.where(eq(subscribers.id, subscriber.id));

		const result = await drainNurtureSends(drainDeps(), { now: NOW });
		expect(result).toMatchObject({ claimed: 1, sent: 0, cancelled: 1 });
		expect(await emailLogTo(subscriber.email)).toEqual([]);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		expect(enrollment.status).toBe('cancelled');
	});

	it('the unsubscribe link in a nurture email works end-to-end and suppresses future sends', async () => {
		await makeSequence();
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);

		// Step 1 goes out; its rendered data carries the unsubscribe URL, and
		// the dry-run record carries the RFC 8058 headers pointing at it.
		await drainNurtureSends(drainDeps(), { now: NOW });
		const [logged] = await emailLogTo(subscriber.email);
		const url = (logged.data as { unsubscribeUrl: string }).unsubscribeUrl;
		expect(url).toBe(`https://example.ro/unsubscribe/${subscriber.unsubscribeToken}`);
		expect(logged.headers).toEqual({
			'List-Unsubscribe': `<${url}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
		});

		// Open the link (GET): the REAL route load renders the confirmation and
		// changes nothing — a mail scanner's prefetch must not unsubscribe.
		const token = url.split('/').pop()!;
		const route = await import('../../../routes/(public)/unsubscribe/[token]/+page.server.ts');
		expect(await route.load({ params: { token } } as Parameters<typeof route.load>[0])).toEqual({
			valid: true
		});
		expect((await sendsOf(enrollment.id)).map((s) => s.status)).toEqual(['sent', 'pending']);

		// Press the button: the POST action revokes.
		const body = new FormData();
		body.set('intent', 'unsubscribe');
		const outcome = await route.actions.default({
			params: { token },
			request: new Request(`https://example.ro${new URL(url).pathname}`, { method: 'POST', body })
		} as unknown as Parameters<typeof route.actions.default>[0]);
		expect(outcome).toEqual({ done: true });

		// Consents revoked, the pending step cancelled, and the step-2 instant
		// delivers nothing.
		const [after] = await db.select().from(subscribers).where(eq(subscribers.id, subscriber.id));
		expect(after.consents.newsletter?.granted).toBe(false);
		expect((await sendsOf(enrollment.id)).map((s) => s.status)).toEqual(['sent', 'cancelled']);
		const step2At = new Date('2026-02-13T07:00:00Z');
		expect(await drainNurtureSends(drainDeps(), { now: step2At })).toMatchObject({ claimed: 0 });
		expect((await emailLogTo(subscriber.email)).length).toBe(1);
	});
});

// Audit 2026-09-03 P2 "Nurture queue frozen at enrollment".
describe('queue re-planning (pause/resume, reseed, retry)', () => {
	const days = (n: number) => n * 24 * 60 * 60 * 1000;

	it('pause → resume past the grace window cancels stale steps as `stale` and sends the rest in order', async () => {
		const sequence = await makeSequence({
			steps: [
				{ offsetDays: 0, templateKey: 'nurture', subject: 'S1', paragraphs: ['P'] },
				{ offsetDays: 4, templateKey: 'nurture', subject: 'S2', paragraphs: ['P'] }
			]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);

		// Operator pauses before anything goes out; resumes 4 days + 1 hour later:
		// step 1 is ~97 h late (past NURTURE_STALE_SEND_HOURS), step 2 is 1 h late.
		await setSequenceActive({ db }, sequence.id, false, NOW);
		const resumeAt = new Date(NOW.getTime() + days(4) + minutes(60));
		expect((await drainNurtureSends(drainDeps(), { now: resumeAt })).claimed).toBe(0);
		await setSequenceActive({ db }, sequence.id, true, resumeAt);

		const result = await drainNurtureSends(drainDeps(), { now: resumeAt });
		expect(result).toMatchObject({ stale: 1, claimed: 1, sent: 1, completed: 1 });
		const sends = await sendsOf(enrollment.id);
		expect(sends.map((s) => s.status)).toEqual(['cancelled', 'sent']);
		expect(sends[0].lastError).toBe('stale');
		// Only step 2 was ever emailed.
		expect((await emailLogTo(subscriber.email)).map((r) => r.idempotencyKey)).toEqual([
			`nurture:${enrollment.id}:1`
		]);
		expect((await enrollmentsOf(subscriber.id))[0].status).toBe('completed');
	});

	it('late-but-within-grace steps of several enrollments go out in (enrollment, step) order', async () => {
		const sequence = await makeSequence({
			steps: [
				{ offsetDays: 0, templateKey: 'nurture', subject: 'S1', paragraphs: ['P'] },
				{ offsetDays: 1, templateKey: 'nurture', subject: 'S2', paragraphs: ['P'] }
			]
		});
		const enrolled: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			const subscriber = await makeSubscriber();
			await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
			enrolled.push((await enrollmentsOf(subscriber.id))[0].id);
		}
		await setSequenceActive({ db }, sequence.id, false, NOW);
		const resumeAt = new Date(NOW.getTime() + days(1) + minutes(60));
		await setSequenceActive({ db }, sequence.id, true, resumeAt);

		const order: string[] = [];
		const recording: EmailSender = {
			dryRun: true,
			send: (input) => {
				order.push(input.idempotencyKey);
				return email.send(input);
			}
		};
		const result = await drainNurtureSends(drainDeps({ email: recording }), { now: resumeAt });
		expect(result).toMatchObject({ claimed: 6, sent: 6, stale: 0 });
		expect(order).toHaveLength(6);
		for (const id of enrolled) {
			const step1 = order.indexOf(`nurture:${id}:0`);
			const step2 = order.indexOf(`nurture:${id}:1`);
			expect(step1).toBeGreaterThanOrEqual(0);
			// Never step 2 before step 1 of the same enrollment.
			expect(step2).toBeGreaterThan(step1);
			// …and the two are adjacent: rows are grouped by enrollment.
			expect(step2).toBe(step1 + 1);
		}
	});

	it('stamps the steps hash at enrollment; a reseed re-plans mismatched pending rows and cancels vanished steps', async () => {
		seq += 1;
		const definition: NurtureSequenceDefinition = {
			key: `nur-hash-${seq}`,
			name: 'Hash',
			trigger: { kind: 'consent-confirmed' },
			consentKey: 'newsletter',
			steps: [
				{ offsetDays: 0, templateKey: 'nurture', subject: 'S1', paragraphs: ['P'] },
				{ offsetDays: 3, templateKey: 'nurture', subject: 'S2', paragraphs: ['P'] }
			]
		};
		await seedNurtureSequences(db, [definition], NOW);
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		const original = stepsHash(definition.steps);
		expect((await sendsOf(enrollment.id)).map((s) => s.stepsHash)).toEqual([original, original]);
		await drainNurtureSends(drainDeps(), { now: NOW });

		// Copy + timing of step 2 change, and a step 3 is added.
		const changed: NurtureSequenceDefinition = {
			...definition,
			steps: [
				definition.steps[0],
				{ offsetDays: 5, templateKey: 'nurture', subject: 'S2 nou', paragraphs: ['Nou.'] },
				{ offsetDays: 8, templateKey: 'nurture', subject: 'S3', paragraphs: ['P'] }
			]
		};
		await seedNurtureSequences(db, [changed], NOW);
		const next = stepsHash(changed.steps);
		let sends = await sendsOf(enrollment.id);
		expect(sends.map((s) => [s.stepIndex, s.status, s.stepsHash])).toEqual([
			[0, 'sent', original], // delivered rows are history — never touched
			[1, 'pending', next], // re-planned from the enrollment instant
			[2, 'pending', next] // added
		]);
		expect(sends[1].scheduledAt).toEqual(computeStepScheduledAt(NOW, changed.steps[1]));
		expect(sends[2].scheduledAt).toEqual(computeStepScheduledAt(NOW, changed.steps[2]));

		// An identical reseed is a no-op for the rows.
		await seedNurtureSequences(db, [changed], NOW);
		expect((await sendsOf(enrollment.id)).map((s) => s.stepsHash)).toEqual([original, next, next]);

		// Shrinking to one step cancels the pending rows whose step vanished.
		await seedNurtureSequences(db, [{ ...definition, steps: [definition.steps[0]] }], NOW);
		sends = await sendsOf(enrollment.id);
		expect(sends.map((s) => [s.stepIndex, s.status, s.lastError])).toEqual([
			[0, 'sent', null],
			[1, 'cancelled', 'replanned'],
			[2, 'cancelled', 'replanned']
		]);
		// Rows planned before the column existed (NULL hash) are left alone.
		await db
			.update(nurtureSends)
			.set({ status: 'pending', stepsHash: null })
			.where(eq(nurtureSends.id, sends[1].id));
		await seedNurtureSequences(db, [changed], NOW);
		expect((await sendsOf(enrollment.id))[1]).toMatchObject({ status: 'pending', stepsHash: null });
	});

	it('the operator retry re-queues a parked send (attempts reset) and the drain delivers it', async () => {
		const failing = createEmailSender({
			db,
			dryRun: false,
			from: 'test@example.ro',
			transport: {
				send: async () => {
					throw new Error('smtp down');
				}
			}
		});
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		let [send] = await sendsOf(enrollment.id);
		await db.update(nurtureSends).set({ attempts: 4 }).where(eq(nurtureSends.id, send.id));
		expect(await drainNurtureSends(drainDeps({ email: failing }), { now: NOW })).toMatchObject({
			parked: 1
		});
		[send] = await sendsOf(enrollment.id);
		expect(send.status).toBe('failed');
		// A parked send keeps the enrollment open (was closed as completed before).
		expect((await enrollmentsOf(subscriber.id))[0].status).toBe('active');

		const later = new Date(NOW.getTime() + minutes(30));
		expect(await retryParkedSend({ db }, send.id, later)).toBe(true);
		[send] = await sendsOf(enrollment.id);
		expect(send).toMatchObject({
			status: 'pending',
			attempts: 0,
			lastError: null,
			scheduledAt: later
		});
		// Not a parked row any more → not retriable again; unknown id → false.
		expect(await retryParkedSend({ db }, send.id, later)).toBe(false);
		expect(await retryParkedSend({ db }, 'no-such-send', later)).toBe(false);

		expect(await drainNurtureSends(drainDeps(), { now: later })).toMatchObject({
			sent: 1,
			completed: 1
		});
		expect((await sendsOf(enrollment.id))[0].status).toBe('sent');
	});

	it('retrying a send of an enrollment closed as completed (legacy) re-opens it', async () => {
		await makeSequence({
			steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
		});
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		const [send] = await sendsOf(enrollment.id);
		await db
			.update(nurtureSends)
			.set({ status: 'failed', attempts: 5, lastError: 'x' })
			.where(eq(nurtureSends.id, send.id));
		await db
			.update(nurtureEnrollments)
			.set({ status: 'completed', closedAt: NOW })
			.where(eq(nurtureEnrollments.id, enrollment.id));

		expect(await retryParkedSend({ db }, send.id, NOW)).toBe(true);
		const [reopened] = await enrollmentsOf(subscriber.id);
		expect(reopened.status).toBe('active');
		expect(reopened.closedAt).toBeNull();
		expect(await drainNurtureSends(drainDeps(), { now: NOW })).toMatchObject({ sent: 1 });
	});
});

describe('sequences as data', () => {
	it('seeds by key, updates definitions on reseed, and NEVER overrides the operator kill switch', async () => {
		seq += 1;
		const definition: NurtureSequenceDefinition = {
			key: `nur-seed-${seq}`,
			name: 'Original',
			trigger: { kind: 'consent-confirmed' },
			consentKey: 'newsletter',
			steps: [
				{ offsetDays: 0, templateKey: 'nurture', subject: 'Salut', paragraphs: ['Bun venit.'] }
			]
		};
		expect(await seedNurtureSequences(db, [definition], NOW)).toBe(1);
		const [row] = await db
			.select()
			.from(nurtureSequences)
			.where(eq(nurtureSequences.key, definition.key));
		expect(row.name).toBe('Original');

		// Operator stops it; a later deploy reseeds with new copy.
		await setSequenceActive({ db }, row.id, false, NOW);
		await seedNurtureSequences(db, [{ ...definition, name: 'Actualizat' }], NOW);
		const [reseeded] = await db
			.select()
			.from(nurtureSequences)
			.where(eq(nurtureSequences.key, definition.key));
		expect(reseeded.id).toBe(row.id);
		expect(reseeded.name).toBe('Actualizat');
		expect(reseeded.active).toBe(false);
	});

	it('refuses an invalid definition loudly', async () => {
		await expect(
			seedNurtureSequences(db, [
				{
					key: 'bad',
					name: 'Bad',
					trigger: { kind: 'consent-confirmed' },
					consentKey: 'newsletter',
					steps: []
				}
			])
		).rejects.toThrow(/at least one step/);
	});
});

describe('retention', () => {
	it('GDPR erasure of the subscriber cascades enrollments and sends', async () => {
		await makeSequence();
		const subscriber = await makeSubscriber();
		await enrollOnConsentConfirmed({ db }, subscriber.id, NOW);
		const [enrollment] = await enrollmentsOf(subscriber.id);
		await db.delete(subscribers).where(eq(subscribers.id, subscriber.id));
		expect(await enrollmentsOf(subscriber.id)).toEqual([]);
		expect(await sendsOf(enrollment.id)).toEqual([]);
	});

	it('prunes only CLOSED enrollments past the cutoff', async () => {
		const sequence = await makeSequence();
		const done = await makeSubscriber();
		const active = await makeSubscriber();
		await db.insert(nurtureEnrollments).values([
			{
				id: `nur-old-closed-${seq}`,
				sequenceId: sequence.id,
				subscriberId: done.id,
				status: 'completed',
				enrolledAt: new Date('2025-01-01T00:00:00Z'),
				closedAt: new Date('2025-01-10T00:00:00Z')
			},
			{
				id: `nur-old-active-${seq}`,
				sequenceId: sequence.id,
				subscriberId: active.id,
				status: 'active',
				enrolledAt: new Date('2025-01-01T00:00:00Z')
			}
		]);
		expect(await pruneNurtureEnrollments(db, new Date('2025-12-01T00:00:00Z'))).toBe(1);
		expect((await enrollmentsOf(active.id)).length).toBe(1);
		expect(await enrollmentsOf(done.id)).toEqual([]);
	});
});
