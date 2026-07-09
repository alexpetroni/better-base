import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getPage, updatePage } from '$lib/modules/pages/server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const page = await getPage({ db: getDb() }, params.id);
	if (!page) error(404);
	return { page };
};

export const actions: Actions = {
	save: async ({ params, request }) => {
		const form = await request.formData();
		const result = await updatePage({ db: getDb() }, params.id, {
			title: String(form.get('title') ?? ''),
			bodyMd: String(form.get('bodyMd') ?? ''),
			seoDescription: String(form.get('seoDescription') ?? '').trim() || null
		});
		if (!result.ok) return fail(result.error === 'not-found' ? 404 : 400, { error: result.error });
		return { saved: true };
	}
};
