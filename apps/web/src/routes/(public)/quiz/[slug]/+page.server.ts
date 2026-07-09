import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { renderMarkdown } from '$lib/modules/blog/server';
import { getQuizBySlug } from '$lib/modules/quiz/server';
import { getSite } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getQuizBySlug({ db: getDb() }, params.slug);
	// Like articles, a quiz is only visible on a site whose config activates
	// its pillar; untagged quizzes are public nowhere.
	if (!found || !found.pillarSlug || !getSite().pillars.includes(found.pillarSlug)) error(404);
	return {
		quiz: {
			slug: found.quiz.slug,
			title: found.quiz.title,
			introHtml: renderMarkdown(found.quiz.introMd),
			formSchema: found.quiz.formSchema,
			// Versions the sessionStorage persistence: editing the quiz discards
			// half-filled answers from the previous revision.
			version: found.quiz.updatedAt.getTime()
		}
	};
};
