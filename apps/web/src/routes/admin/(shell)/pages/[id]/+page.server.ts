import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getPage, updatePage } from '$lib/modules/pages/server';
import { failResult, formStr } from '$lib/server/forms';
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
			title: formStr(form, 'title'),
			bodyMd: formStr(form, 'bodyMd'),
			seoDescription: formStr(form, 'seoDescription').trim() || null
		});
		if (!result.ok) return failResult(result);
		return { saved: true };
	}
};
