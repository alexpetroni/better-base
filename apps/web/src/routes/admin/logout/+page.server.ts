import { redirect } from '@sveltejs/kit';
import { getAuth } from '$lib/modules/auth';
import type { Actions, PageServerLoad } from './$types';

// Logout is POST-only; a GET just returns to the dashboard.
export const load: PageServerLoad = () => {
	redirect(303, '/admin');
};

export const actions: Actions = {
	default: async (event) => {
		await getAuth().api.signOut({ headers: event.request.headers });
		redirect(303, '/admin/login');
	}
};
