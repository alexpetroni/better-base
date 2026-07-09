import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { createArticle, listArticles } from '$lib/modules/blog/server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const statusParam = url.searchParams.get('status');
	const status = statusParam === 'draft' || statusParam === 'published' ? statusParam : undefined;
	const search = url.searchParams.get('q') ?? '';
	const articles = await listArticles({ db: getDb() }, { status, search });
	return { articles, filter: { status: status ?? 'all', search } };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const title = String(form.get('title') ?? '');
		// The admin hook guard guarantees a staff user here.
		const result = await createArticle({ db: getDb() }, { title, createdBy: locals.user!.id });
		if (!result.ok) return fail(400, { error: result.error });
		redirect(303, `/admin/articles/${result.value.id}`);
	}
};
