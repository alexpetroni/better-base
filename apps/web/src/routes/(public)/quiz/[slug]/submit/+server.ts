import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getQuizBySlug, sanitizeSubmittedAnswers, submitQuiz } from '$lib/modules/quiz/server';
import { getSite } from '$lib/server/site';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 256 * 1024;

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
	const submitted = await submitQuiz({ db }, { quizId: found.quiz.id, answers });
	if (!submitted.ok) error(500, 'Could not store the submission');

	return json({ redirectUrl: `/quiz/${params.slug}/rezultat/${submitted.value.id}` });
};
