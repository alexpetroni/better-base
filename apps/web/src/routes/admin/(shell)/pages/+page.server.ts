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
		// The pages section holds the LEGAL pages (T&C, privacy, cookies) —
		// admin-only, see ADMIN_ONLY_SECTIONS.
		require: 'admin',
		create: (title) => createPage({ db: getDb() }, { title }),
		redirectTo: (page) => `/admin/pages/${page.id}`
	})
};
