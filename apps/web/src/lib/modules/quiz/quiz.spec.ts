import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FormConfig } from 'formcomp';
import { createDb, type Db } from '../../db/client.ts';
import { seedPillars } from '../../db/seed.ts';
import { users } from '../auth/schema.ts';
import { emailLog } from '../email/schema.ts';
import { createEmailSender } from '../email/service.ts';
import { hasConsent } from '../crm/consent.ts';
import { subscribers } from '../crm/schema.ts';
import { unsubscribeByToken } from '../crm/service.ts';
import { claimQuizResult, type QuizFunnelDeps } from './funnel.ts';
import { quizResults, type QuizRow, type StoredAnswer } from './schema.ts';
import type { ScoringConfig } from './scoring.ts';
import {
	createQuiz,
	getQuizBySlug,
	latestResults,
	listQuizzes,
	publishQuiz,
	sanitizeSubmittedAnswers,
	submitQuiz,
	unpublishQuiz,
	updateQuiz,
	type QuizDeps
} from './service.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh). Email always runs DRY — the funnel never touches a transport.
let db: Db;
let deps: QuizDeps;
let funnelDeps: QuizFunnelDeps;

const USER_ID = 'quiz-spec-user';

const FORM: FormConfig = {
	steps: [
		{
			id: 'noapte',
			label: 'Noaptea',
			groups: [
				{
					id: 'g1',
					label: 'Adormire',
					questions: [
						{
							id: 'adormire',
							type: 'single-select',
							label: 'Cât durează să adormi?',
							options: [
								{ value: 'repede', label: 'Repede' },
								{ value: 'greu', label: 'Greu' }
							]
						},
						{ id: 'oboseala', type: 'scale', label: 'Oboseală', min: 1, max: 5 }
					]
				}
			]
		}
	]
};

const SCORING: ScoringConfig = {
	questions: {
		adormire: { kind: 'map', map: { repede: 0, greu: 4 } },
		oboseala: { kind: 'numeric' }
	},
	bands: [
		{ key: 'bun', min: 0, label: 'Somn bun', advice: 'Continuă așa.' },
		{ key: 'risc', min: 5, label: 'Risc', advice: 'Atenție.' }
	]
};

const ANSWERS: StoredAnswer[] = [
	{
		uuid: 'u-adormire',
		questionId: 'adormire',
		stepId: 'noapte',
		type: 'single-select',
		label: 'Cât durează să adormi?',
		value: 'greu',
		displayValue: 'Greu'
	},
	{
		uuid: 'u-oboseala',
		questionId: 'oboseala',
		stepId: 'noapte',
		type: 'scale',
		label: 'Oboseală',
		value: 3,
		displayValue: '3'
	}
];

async function makePublishedQuiz(title: string): Promise<QuizRow> {
	const created = await createQuiz(deps, { title, createdBy: USER_ID });
	if (!created.ok) throw new Error('createQuiz failed');
	const updated = await updateQuiz(deps, created.value.id, {
		formSchema: FORM,
		scoring: SCORING,
		pillarSlug: 'somn'
	});
	if (!updated.ok) throw new Error(`updateQuiz failed: ${updated.error}`);
	const published = await publishQuiz(deps, created.value.id);
	if (!published.ok) throw new Error(`publishQuiz failed: ${published.detail}`);
	return published.value;
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle')
	});
	await seedPillars(db, ['somn', 'nutritie']);
	await db.insert(users).values({ id: USER_ID, name: 'Quiz Spec', email: 'quiz-spec@example.com' });
	deps = { db };
	funnelDeps = {
		db,
		email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
		secret: 'quiz-spec-secret',
		baseUrl: 'https://example.ro',
		siteName: 'Better Sleep'
	};
});

afterAll(async () => {
	await db?.$client.end();
});

describe('quiz lifecycle', () => {
	it('creates with a unique ro slug and dedupes collisions', async () => {
		const a = await createQuiz(deps, { title: 'Evaluarea somnului', createdBy: USER_ID });
		const b = await createQuiz(deps, { title: 'Evaluarea somnului', createdBy: USER_ID });
		expect(a.ok && a.value.slug).toBe('evaluarea-somnului');
		expect(b.ok && b.value.slug).toBe('evaluarea-somnului-2');
	});

	it('rejects an invalid scoring config against the current form schema', async () => {
		const created = await createQuiz(deps, { title: 'Scor invalid', createdBy: USER_ID });
		if (!created.ok) throw new Error('createQuiz failed');
		await updateQuiz(deps, created.value.id, { formSchema: FORM });
		const bad = await updateQuiz(deps, created.value.id, {
			scoring: { questions: { fantoma: { kind: 'map', map: {} } }, bands: SCORING.bands }
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toBe('invalid-scoring');
	});

	it('rejects tagging to an unknown pillar', async () => {
		const created = await createQuiz(deps, { title: 'Pilon necunoscut', createdBy: USER_ID });
		if (!created.ok) throw new Error('createQuiz failed');
		const bad = await updateQuiz(deps, created.value.id, { pillarSlug: 'inexistent' });
		expect(!bad.ok && bad.error).toBe('unknown-pillar');
	});

	it('an empty quiz cannot be published; a complete one can', async () => {
		const created = await createQuiz(deps, { title: 'Gol', createdBy: USER_ID });
		if (!created.ok) throw new Error('createQuiz failed');
		const refused = await publishQuiz(deps, created.value.id);
		expect(!refused.ok && refused.error).toBe('not-publishable');

		const quiz = await makePublishedQuiz('Complet');
		expect(quiz.status).toBe('published');
	});

	it('drafts are invisible via public getQuizBySlug; unpublish hides again', async () => {
		const quiz = await makePublishedQuiz('Vizibilitate');
		expect(await getQuizBySlug(deps, quiz.slug)).not.toBeNull();
		await unpublishQuiz(deps, quiz.id);
		expect(await getQuizBySlug(deps, quiz.slug)).toBeNull();
		expect(await getQuizBySlug(deps, quiz.slug, { includeDrafts: true })).not.toBeNull();
	});
});

describe('submission', () => {
	it('sanitizes untrusted answers to known question ids', () => {
		const cleaned = sanitizeSubmittedAnswers(
			[
				...ANSWERS,
				{ questionId: 'necunoscut', value: 'x' },
				'garbage',
				null,
				{ noQuestionId: true }
			],
			FORM
		);
		expect(cleaned.map((a) => a.questionId)).toEqual(['adormire', 'oboseala']);
	});

	it('scores and stores a result with the full profile', async () => {
		const quiz = await makePublishedQuiz('Trimitere');
		const submitted = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		expect(submitted.value.score).toBe(7);
		expect(submitted.value.profile.band.key).toBe('risc');
		expect(submitted.value.subscriberId).toBeNull();
		expect(submitted.value.answers).toHaveLength(2);

		const latest = await latestResults(deps, quiz.id);
		expect(latest.map((r) => r.id)).toContain(submitted.value.id);
	});

	it('a double-submit with the same attempt token stores exactly one result (audit resilience #8)', async () => {
		const quiz = await makePublishedQuiz('Idempotent');
		const token = crypto.randomUUID();

		// Race the duplicates like a real replay would — not one after the other.
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS, clientToken: token })
			)
		);
		const ids = results.map((r) => (r.ok ? r.value.id : r.error));
		expect(new Set(ids).size).toBe(1);

		// And a plain sequential refresh-resubmit returns the original row too.
		const again = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS, clientToken: token });
		expect(again.ok && again.value.id).toBe(ids[0]);

		const stored = await db.select().from(quizResults).where(eq(quizResults.quizId, quiz.id));
		expect(stored).toHaveLength(1);
	});

	it('the same token with EDITED answers is a new attempt; no token means no dedup', async () => {
		const quiz = await makePublishedQuiz('Atenuare');
		const token = crypto.randomUUID();
		const first = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS, clientToken: token });
		const edited = await submitQuiz(deps, { quizId: quiz.id, answers: [], clientToken: token });
		expect(first.ok && edited.ok && first.value.id !== edited.value.id).toBe(true);

		const a = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		const b = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		expect(a.ok && b.ok && a.value.id !== b.value.id).toBe(true);
	});

	it('lists quizzes with result counts for the admin', async () => {
		const quiz = await makePublishedQuiz('Numărătoare');
		await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		await submitQuiz(deps, { quizId: quiz.id, answers: [] });
		const listed = await listQuizzes(deps);
		const item = listed.find((i) => i.quiz.id === quiz.id);
		expect(item?.resultsCount).toBe(2);
		expect(item?.pillarSlug).toBe('somn');
	});
});

describe('the email funnel', () => {
	it('claim links the subscriber, sends ONE quiz-result email even when retried, and starts double opt-in', async () => {
		const quiz = await makePublishedQuiz('Funnel complet');
		const submitted = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		if (!submitted.ok) throw new Error('submit failed');

		const input = {
			resultId: submitted.value.id,
			email: 'funnel@example.ro',
			name: 'Fani',
			newsletter: true,
			profileEmails: false
		};
		const first = await claimQuizResult(funnelDeps, input);
		// The handler retries (double click, network replay) — same input.
		const second = await claimQuizResult(funnelDeps, input);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.resultEmail).toBe('dryrun');
		expect(second.resultEmail).toBe('skipped');
		expect(first.newsletterConfirm).toBe('dryrun');
		expect(second.newsletterConfirm).toBe('skipped');

		// Subscriber row exists, with quiz-sourced newsletter consent, untouched profile_emails.
		const [subscriber] = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.email, 'funnel@example.ro'));
		expect(subscriber).toBeDefined();
		expect(hasConsent(subscriber.consents, 'newsletter')).toBe(true);
		expect(subscriber.consents.newsletter?.source).toBe(`quiz:${quiz.slug}`);
		expect(subscriber.consents.profile_emails).toBeUndefined();

		// The result row is linked to the subscriber.
		const [result] = await db
			.select()
			.from(quizResults)
			.where(eq(quizResults.id, submitted.value.id));
		expect(result.subscriberId).toBe(subscriber.id);

		// Exactly ONE quiz-result and ONE newsletter-confirm email_log entry.
		const logs = await db.select().from(emailLog).where(eq(emailLog.toEmail, 'funnel@example.ro'));
		expect(logs.filter((l) => l.template === 'quiz-result')).toHaveLength(1);
		expect(logs.filter((l) => l.template === 'newsletter-confirm')).toHaveLength(1);
		expect(logs.every((l) => l.status === 'dryrun')).toBe(true);
	});

	it('without newsletter consent only the transactional result email goes out', async () => {
		const quiz = await makePublishedQuiz('Doar rezultat');
		const submitted = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		if (!submitted.ok) throw new Error('submit failed');

		const outcome = await claimQuizResult(funnelDeps, {
			resultId: submitted.value.id,
			email: 'doar-rezultat@example.ro',
			newsletter: false,
			profileEmails: false
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.resultEmail).toBe('dryrun');
		expect(outcome.newsletterConfirm).toBe('not-requested');

		const logs = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.toEmail, 'doar-rezultat@example.ro'));
		expect(logs).toHaveLength(1);
		expect(logs[0].template).toBe('quiz-result');

		const [subscriber] = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.email, 'doar-rezultat@example.ro'));
		expect(hasConsent(subscriber.consents, 'newsletter')).toBe(false);
	});

	it('a corrected email address still receives its result email', async () => {
		const quiz = await makePublishedQuiz('Typo');
		const submitted = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		if (!submitted.ok) throw new Error('submit failed');

		await claimQuizResult(funnelDeps, {
			resultId: submitted.value.id,
			email: 'typo@example.ro',
			newsletter: false,
			profileEmails: false
		});
		const corrected = await claimQuizResult(funnelDeps, {
			resultId: submitted.value.id,
			email: 'corect@example.ro',
			newsletter: false,
			profileEmails: false
		});
		expect(corrected.ok && corrected.resultEmail).toBe('dryrun');
	});

	it('unsubscribing after the quiz funnel flips consent off', async () => {
		const quiz = await makePublishedQuiz('Dezabonare');
		const submitted = await submitQuiz(deps, { quizId: quiz.id, answers: ANSWERS });
		if (!submitted.ok) throw new Error('submit failed');
		const claimed = await claimQuizResult(funnelDeps, {
			resultId: submitted.value.id,
			email: 'pleaca@example.ro',
			newsletter: true,
			profileEmails: true
		});
		if (!claimed.ok) throw new Error('claim failed');

		const [before] = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.email, 'pleaca@example.ro'));
		expect(hasConsent(before.consents, 'newsletter')).toBe(true);
		expect(hasConsent(before.consents, 'profile_emails')).toBe(true);

		const after = await unsubscribeByToken({ db }, before.unsubscribeToken);
		expect(hasConsent(after!.consents, 'newsletter')).toBe(false);
		expect(hasConsent(after!.consents, 'profile_emails')).toBe(false);
	});

	it('claiming an unknown result fails cleanly', async () => {
		const outcome = await claimQuizResult(funnelDeps, {
			resultId: 'no-such-result',
			email: 'x@example.ro',
			newsletter: false,
			profileEmails: false
		});
		expect(outcome).toEqual({ ok: false, error: 'not-found' });
	});
});
