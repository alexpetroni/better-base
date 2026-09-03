import { getDb } from '$lib/db';
import { createQuiz, listQuizzes } from '$lib/modules/quiz/server';
import { createEntityAction, parseListFilter } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const { status, search, filter } = parseListFilter(url, ['draft', 'published']);
	const quizzes = await listQuizzes({ db: getDb() }, { status, search });
	return { quizzes, filter };
};

export const actions: Actions = {
	create: createEntityAction({
		field: 'title',
		require: 'staff',
		create: (title, user) => createQuiz({ db: getDb() }, { title, createdBy: user.id }),
		redirectTo: (quiz) => `/admin/quizzes/${quiz.id}`
	})
};
