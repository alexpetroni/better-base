import { getDb } from '$lib/db';
import { createPage, listPages } from '$lib/modules/pages/server';
import { createEntityAction } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { pages: await listPages({ db: getDb() }) };
};

export const actions: Actions = {
	create: createEntityAction({
		field: 'title',
		create: (title) => createPage({ db: getDb() }, { title }),
		redirectTo: (page) => `/admin/pages/${page.id}`
	})
};
