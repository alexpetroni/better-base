import { getDb } from '$lib/db';
import { createArticle, listArticles } from '$lib/modules/blog/server';
import { createEntityAction, parseListFilter } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const { status, search, filter } = parseListFilter(url, ['draft', 'published']);
	const articles = await listArticles({ db: getDb() }, { status, search });
	return { articles, filter };
};

export const actions: Actions = {
	create: createEntityAction({
		field: 'title',
		// The admin hook guard guarantees a staff user here.
		create: (title, locals) =>
			createArticle({ db: getDb() }, { title, createdBy: locals.user!.id }),
		redirectTo: (article) => `/admin/articles/${article.id}`
	})
};
