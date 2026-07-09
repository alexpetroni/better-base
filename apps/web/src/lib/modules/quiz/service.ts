import { createHash } from 'node:crypto';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FormConfig } from 'formcomp';
import type { Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { nextUniqueSlug, slugify } from '../blog/slug.ts';
import { subscribers } from '../crm/schema.ts';
import {
	quizResults,
	quizzes,
	type QuizResultRow,
	type QuizRow,
	type QuizStatus,
	type StoredAnswer
} from './schema.ts';
import {
	answersFromSubmitAnswers,
	scoreQuiz,
	validateScoringConfig,
	type ScoringConfig
} from './scoring.ts';
import { validateFormSchema, validateForPublish } from './validate.ts';

/** Quiz services. Framework-free ({ db } passed in), like blog. */

export interface QuizDeps {
	db: Db;
}

export type QuizError =
	| 'not-found'
	| 'invalid-title'
	| 'invalid-slug'
	| 'unknown-pillar'
	| 'invalid-form-schema'
	| 'invalid-scoring'
	| 'not-publishable';

export type QuizOpResult<T> =
	{ ok: true; value: T } | { ok: false; error: QuizError; detail?: string };

async function ensureUniqueQuizSlug(deps: QuizDeps, base: string, excludeId?: string) {
	const root = slugify(base) || 'chestionar';
	const taken = await deps.db
		.select({ slug: quizzes.slug, id: quizzes.id })
		.from(quizzes)
		.where(or(eq(quizzes.slug, root), ilike(quizzes.slug, `${root}-%`)));
	const takenSet = new Set(taken.filter((r) => r.id !== excludeId).map((r) => r.slug));
	return nextUniqueSlug(root, (slug) => takenSet.has(slug));
}

export async function createQuiz(
	deps: QuizDeps,
	input: { title: string; createdBy: string }
): Promise<QuizOpResult<QuizRow>> {
	const title = input.title.trim();
	if (!title) return { ok: false, error: 'invalid-title' };
	const slug = await ensureUniqueQuizSlug(deps, title);
	const [row] = await deps.db
		.insert(quizzes)
		.values({ id: crypto.randomUUID(), slug, title, createdBy: input.createdBy })
		.returning();
	return { ok: true, value: row };
}

export interface QuizPatch {
	title?: string;
	slug?: string;
	introMd?: string;
	/** Slug of the pillar this quiz belongs to, or null to untag. */
	pillarSlug?: string | null;
	formSchema?: FormConfig;
	scoring?: ScoringConfig;
	resultTemplateKey?: string;
}

export async function updateQuiz(
	deps: QuizDeps,
	id: string,
	patch: QuizPatch
): Promise<QuizOpResult<QuizRow>> {
	const [existing] = await deps.db.select().from(quizzes).where(eq(quizzes.id, id));
	if (!existing) return { ok: false, error: 'not-found' };

	const set: Partial<typeof quizzes.$inferInsert> = { updatedAt: new Date() };
	if (patch.title !== undefined) {
		const title = patch.title.trim();
		if (!title) return { ok: false, error: 'invalid-title' };
		set.title = title;
	}
	if (patch.slug !== undefined) {
		const normalized = slugify(patch.slug);
		if (!normalized) return { ok: false, error: 'invalid-slug' };
		set.slug = await ensureUniqueQuizSlug(deps, normalized, id);
	}
	if (patch.introMd !== undefined) set.introMd = patch.introMd;
	if (patch.resultTemplateKey !== undefined) set.resultTemplateKey = patch.resultTemplateKey;

	if (patch.formSchema !== undefined) {
		const errors = validateFormSchema(patch.formSchema);
		if (errors.length) {
			return { ok: false, error: 'invalid-form-schema', detail: errors.join(' ') };
		}
		set.formSchema = patch.formSchema;
	}
	if (patch.scoring !== undefined) {
		const form = patch.formSchema ?? existing.formSchema;
		const errors = validateScoringConfig(form, patch.scoring);
		if (errors.length) return { ok: false, error: 'invalid-scoring', detail: errors.join(' ') };
		set.scoring = patch.scoring;
	}

	if (patch.pillarSlug !== undefined) {
		if (patch.pillarSlug === null) {
			set.pillarId = null;
		} else {
			const [pillar] = await deps.db
				.select()
				.from(pillars)
				.where(eq(pillars.slug, patch.pillarSlug));
			if (!pillar) return { ok: false, error: 'unknown-pillar', detail: patch.pillarSlug };
			set.pillarId = pillar.id;
		}
	}

	const [row] = await deps.db.update(quizzes).set(set).where(eq(quizzes.id, id)).returning();
	return { ok: true, value: row };
}

/** Publishing requires a renderable form, ≥1 question and a valid scoring config. */
export async function publishQuiz(deps: QuizDeps, id: string): Promise<QuizOpResult<QuizRow>> {
	const [existing] = await deps.db.select().from(quizzes).where(eq(quizzes.id, id));
	if (!existing) return { ok: false, error: 'not-found' };
	const errors = validateForPublish(existing.formSchema, existing.scoring);
	if (errors.length) return { ok: false, error: 'not-publishable', detail: errors.join(' ') };
	const [row] = await deps.db
		.update(quizzes)
		.set({ status: 'published', updatedAt: new Date() })
		.where(eq(quizzes.id, id))
		.returning();
	return { ok: true, value: row };
}

export async function unpublishQuiz(deps: QuizDeps, id: string): Promise<QuizOpResult<QuizRow>> {
	const [row] = await deps.db
		.update(quizzes)
		.set({ status: 'draft', updatedAt: new Date() })
		.where(eq(quizzes.id, id))
		.returning();
	return row ? { ok: true, value: row } : { ok: false, error: 'not-found' };
}

export interface QuizWithPillar {
	quiz: QuizRow;
	pillarSlug: string | null;
}

async function withPillar(deps: QuizDeps, quiz: QuizRow): Promise<QuizWithPillar> {
	if (quiz.pillarId === null) return { quiz, pillarSlug: null };
	const [pillar] = await deps.db.select().from(pillars).where(eq(pillars.id, quiz.pillarId));
	return { quiz, pillarSlug: pillar?.slug ?? null };
}

export async function getQuiz(deps: QuizDeps, id: string): Promise<QuizWithPillar | null> {
	const [quiz] = await deps.db.select().from(quizzes).where(eq(quizzes.id, id));
	return quiz ? withPillar(deps, quiz) : null;
}

/** Fetch by slug. Public callers get published quizzes only (the default). */
export async function getQuizBySlug(
	deps: QuizDeps,
	slug: string,
	opts: { includeDrafts?: boolean } = {}
): Promise<QuizWithPillar | null> {
	const [quiz] = await deps.db.select().from(quizzes).where(eq(quizzes.slug, slug));
	if (!quiz) return null;
	if (quiz.status !== 'published' && !opts.includeDrafts) return null;
	return withPillar(deps, quiz);
}

export interface QuizListItem {
	quiz: QuizRow;
	pillarSlug: string | null;
	resultsCount: number;
}

/** Admin listing: newest-updated first, with per-quiz result counts. */
export async function listQuizzes(
	deps: QuizDeps,
	opts: { status?: QuizStatus; search?: string } = {}
): Promise<QuizListItem[]> {
	const conditions = [];
	if (opts.status) conditions.push(eq(quizzes.status, opts.status));
	if (opts.search?.trim()) {
		const term = `%${opts.search.trim()}%`;
		conditions.push(or(ilike(quizzes.title, term), ilike(quizzes.slug, term)));
	}
	const rows = await deps.db
		.select({
			quiz: quizzes,
			pillarSlug: pillars.slug,
			resultsCount: sql<number>`(select count(*)::int from ${quizResults} where ${quizResults.quizId} = ${quizzes.id})`
		})
		.from(quizzes)
		.leftJoin(pillars, eq(quizzes.pillarId, pillars.id))
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(quizzes.updatedAt), desc(quizzes.id));
	return rows;
}

/**
 * Keep only answers whose questionId exists in the form schema, with all
 * label-ish fields coerced to strings — the submit endpoint feeds this
 * untrusted JSON. Pure.
 */
export function sanitizeSubmittedAnswers(raw: unknown, form: FormConfig): StoredAnswer[] {
	if (!Array.isArray(raw)) return [];
	const knownIds = new Set(
		form.steps.flatMap((s) => s.groups.flatMap((g) => g.questions.map((q) => q.id)))
	);
	const out: StoredAnswer[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const answer = item as Record<string, unknown>;
		const questionId = String(answer.questionId ?? '');
		if (!knownIds.has(questionId)) continue;
		out.push({
			uuid: String(answer.uuid ?? questionId),
			questionId,
			stepId: String(answer.stepId ?? ''),
			type: String(answer.type ?? ''),
			label: String(answer.label ?? ''),
			value: answer.value,
			displayValue: String(answer.displayValue ?? '')
		});
	}
	return out;
}

/**
 * Idempotency key stored in `quiz_results.client_token`: the visitor's
 * per-attempt token scoped by a digest of the sanitized answers. A retried
 * POST (refresh, network replay, double-submit) carries the same token and
 * answers → same key → the original row is returned; going back and
 * resubmitting EDITED answers changes the digest → a fresh result.
 */
export function submissionKey(clientToken: string, answers: StoredAnswer[]): string {
	const digest = createHash('sha256').update(JSON.stringify(answers)).digest('hex');
	return `${clientToken}.${digest}`;
}

/** Score and store one submission. The caller decides whether drafts may submit. */
export async function submitQuiz(
	deps: QuizDeps,
	input: { quizId: string; answers: StoredAnswer[]; clientToken?: string }
): Promise<QuizOpResult<QuizResultRow>> {
	const [quiz] = await deps.db.select().from(quizzes).where(eq(quizzes.id, input.quizId));
	if (!quiz) return { ok: false, error: 'not-found' };
	if (quiz.scoring.bands.length === 0) {
		return { ok: false, error: 'invalid-scoring', detail: 'no bands' };
	}
	const profile = scoreQuiz(quiz.formSchema, quiz.scoring, answersFromSubmitAnswers(input.answers));
	const clientToken = input.clientToken ? submissionKey(input.clientToken, input.answers) : null;
	const [row] = await deps.db
		.insert(quizResults)
		.values({
			id: crypto.randomUUID(),
			quizId: quiz.id,
			answers: input.answers,
			score: Math.round(profile.score),
			profile,
			clientToken
		})
		.onConflictDoNothing({ target: [quizResults.quizId, quizResults.clientToken] })
		.returning();
	if (row) return { ok: true, value: row };
	// Conflict: this exact attempt was already stored — return the original row.
	const [existing] = await deps.db
		.select()
		.from(quizResults)
		.where(and(eq(quizResults.quizId, quiz.id), eq(quizResults.clientToken, clientToken!)));
	// No row despite the conflict only if the quiz (and its results) were
	// deleted between the two statements.
	return existing
		? { ok: true, value: existing }
		: { ok: false, error: 'not-found', detail: 'result gone after conflict' };
}

export interface ResultWithQuiz {
	result: QuizResultRow;
	quiz: QuizRow;
}

export async function getResultWithQuiz(
	deps: QuizDeps,
	resultId: string
): Promise<ResultWithQuiz | null> {
	const [row] = await deps.db
		.select({ result: quizResults, quiz: quizzes })
		.from(quizResults)
		.innerJoin(quizzes, eq(quizResults.quizId, quizzes.id))
		.where(eq(quizResults.id, resultId));
	return row ?? null;
}

/** Latest results with the (optional) claiming subscriber's email — admin view. */
export async function latestResultsWithEmail(
	deps: QuizDeps,
	quizId: string,
	limit = 20
): Promise<Array<{ result: QuizResultRow; email: string | null }>> {
	return deps.db
		.select({ result: quizResults, email: subscribers.email })
		.from(quizResults)
		.leftJoin(subscribers, eq(quizResults.subscriberId, subscribers.id))
		.where(eq(quizResults.quizId, quizId))
		.orderBy(desc(quizResults.createdAt), desc(quizResults.id))
		.limit(limit);
}

/** Latest results for the admin quiz page. */
export async function latestResults(
	deps: QuizDeps,
	quizId: string,
	limit = 20
): Promise<QuizResultRow[]> {
	return deps.db
		.select()
		.from(quizResults)
		.where(eq(quizResults.quizId, quizId))
		.orderBy(desc(quizResults.createdAt), desc(quizResults.id))
		.limit(limit);
}
