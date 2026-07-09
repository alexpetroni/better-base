import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getQuizBySlug, sanitizeSubmittedAnswers, submitQuiz } from '$lib/modules/quiz/server';
import { getSite } from '$lib/server/site';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 256 * 1024;

// Per-attempt idempotency token sent by the quiz page (a browser uuid). Bound
// in length/alphabet so it can't smuggle arbitrary data into the DB.
const ATTEMPT_TOKEN = /^[A-Za-z0-9-]{8,64}$/;

/** Receives formcomp's submit POST, scores + stores, and redirects to the result page. */
export const POST: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const found = await getQuizBySlug({ db }, params.slug);
	if (!found || !found.pillarSlug || !getSite().pillars.includes(found.pillarSlug)) error(404);

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_BODY_BYTES) error(413);
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	const rawAnswers = (body as { answers?: unknown } | null)?.answers;
	const answers = sanitizeSubmittedAnswers(rawAnswers, found.quiz.formSchema);
	// A double-submit/refresh replays the same token + answers → same result
	// row. Clients without the header (or with a malformed one) just get no
	// idempotency, like before.
	const attemptToken = request.headers.get('x-quiz-attempt');
	const clientToken = attemptToken && ATTEMPT_TOKEN.test(attemptToken) ? attemptToken : undefined;
	const submitted = await submitQuiz({ db }, { quizId: found.quiz.id, answers, clientToken });
	if (!submitted.ok) error(500, 'Could not store the submission');

	return json({ redirectUrl: `/quiz/${params.slug}/rezultat/${submitted.value.id}` });
};
