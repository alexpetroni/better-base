import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { subscribers } from '../crm/schema.ts';
import { emailLog } from '../email/schema.ts';
import { createEmailSender, type EmailSender } from '../email/service.ts';
import { quizResults, quizzes } from '../quiz/schema.ts';
import { drainNurtureSends, type NurtureDrainDeps } from './drain.ts';
import type { NurtureSequenceDefinition, SequenceStep, SequenceTrigger } from './definition.ts';
import { computeStepScheduledAt } from './schedule.ts';
import { nurtureEnrollments, nurtureSends, nurtureSequences } from './schema.ts';
import {
	cancelSubscriberNurture,
	enrollFromOrderEmail,
	enrollFromQuizResult,
	enrollOnConsentConfirmed,
	listParkedSends,
	listSequencesWithStats,
	pruneNurtureEnrollments,
	seedNurtureSequences,
	setSequenceActive
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

		// Step 1 goes out; its rendered data carries the unsubscribe URL.
		await drainNurtureSends(drainDeps(), { now: NOW });
		const [logged] = await emailLogTo(subscriber.email);
		const url = (logged.data as { unsubscribeUrl: string }).unsubscribeUrl;
		expect(url).toBe(`https://example.ro/unsubscribe/${subscriber.unsubscribeToken}`);

		// Click the link: the REAL route load, with the token from the email.
		const token = url.split('/').pop()!;
		const route = await import('../../../routes/(public)/unsubscribe/[token]/+page.server.ts');
		const outcome = await route.load({ params: { token } } as Parameters<typeof route.load>[0]);
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
