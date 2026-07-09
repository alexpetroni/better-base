import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { claimQuizResult, getQuizFunnelDeps, getResultWithQuiz } from '$lib/modules/quiz/server';
import { consumePublicEmailBudget } from '$lib/server/rate-limit';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getResultWithQuiz({ db: getDb() }, params.resultId);
	if (!found || found.quiz.slug !== params.slug || found.quiz.status !== 'published') error(404);
	return {
		quizTitle: found.quiz.title,
		quizSlug: found.quiz.slug,
		profile: found.result.profile,
		// The visitor may already have left an email for this result (reload).
		claimed: found.result.subscriberId !== null
	};
};

export const actions: Actions = {
	// The email step is OPTIONAL — the result above stays visible without it.
	// Consent checkboxes arrive only when explicitly ticked (GDPR default-off).
	email: async ({ params, request, getClientAddress }) => {
		const form = await request.formData();
		// This action emails a visitor-supplied address: throttle per IP and
		// globally before doing anything (a CAPTCHA check would slot in here —
		// see $lib/server/rate-limit/public-email.ts).
		const budget = await consumePublicEmailBudget(getDb(), 'quiz-email', getClientAddress());
		if (budget.limited) return fail(429, { error: 'rate-limited' as const });
		const outcome = await claimQuizResult(getQuizFunnelDeps(), {
			resultId: params.resultId,
			email: String(form.get('email') ?? ''),
			name: String(form.get('name') ?? '') || undefined,
			locale: getSite().locales[0],
			newsletter: form.get('newsletter_consent') === 'yes',
			profileEmails: form.get('profile_consent') === 'yes'
		});
		if (!outcome.ok) {
			if (outcome.error === 'not-found') error(404);
			return fail(400, { error: 'invalid-email' });
		}
		return { sent: true };
	}
};
