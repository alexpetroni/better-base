// Server module barrel: schema, services, funnel and env-bound deps.
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import { getEmailSender } from '$lib/modules/email/server';
import { getSite } from '$lib/server/site';
import type { QuizFunnelDeps } from './funnel.ts';

export {
	claimQuizResult,
	type ClaimQuizResultInput,
	type ClaimQuizResultOutcome,
	type QuizFunnelDeps
} from './funnel.ts';
export { quizResults, quizzes } from './schema.ts';
export {
	createQuiz,
	getQuiz,
	getQuizBySlug,
	getResultWithQuiz,
	latestResults,
	latestResultsWithEmail,
	listQuizzes,
	publishQuiz,
	sanitizeSubmittedAnswers,
	submitQuiz,
	unpublishQuiz,
	updateQuiz,
	type QuizDeps,
	type QuizError,
	type QuizListItem,
	type QuizOpResult,
	type QuizPatch,
	type QuizWithPillar,
	type ResultWithQuiz
} from './service.ts';

/** Funnel deps for the running app (routes). Tests build these explicitly. */
export function getQuizFunnelDeps(): QuizFunnelDeps {
	if (!env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is not set');
	if (!publicEnv.PUBLIC_SITE_URL) throw new Error('PUBLIC_SITE_URL is not set');
	return {
		db: getDb(),
		email: getEmailSender(),
		secret: env.BETTER_AUTH_SECRET,
		baseUrl: publicEnv.PUBLIC_SITE_URL.replace(/\/$/, ''),
		siteName: getSite().name
	};
}
