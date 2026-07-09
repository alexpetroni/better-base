import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { createPage, listPages } from '$lib/modules/pages/server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { pages: await listPages({ db: getDb() }) };
};

export const actions: Actions = {
	create: async ({ request }) => {
		const form = await request.formData();
		const title = String(form.get('title') ?? '');
		const result = await createPage({ db: getDb() }, { title });
		if (!result.ok) return fail(400, { error: result.error });
		redirect(303, `/admin/pages/${result.value.id}`);
	}
};
