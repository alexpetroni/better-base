import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { getDb } from '$lib/db';
import { clearAttempts, getAuth, rateLimitKey, registerLoginAttempt } from '$lib/modules/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, '/admin');
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();
		const password = String(form.get('password') ?? '');
		if (!email || !password) return fail(400, { error: 'invalid_credentials' as const, email });

		const db = getDb();
		const key = rateLimitKey(event.getClientAddress(), email);
		// Count the attempt atomically BEFORE checking the password: the cap
		// decision comes from the post-increment count, so a concurrent burst
		// cannot slip past it (a successful login clears the counter below).
		const attempt = await registerLoginAttempt(db, key);
		if (attempt.limited) return fail(429, { error: 'rate_limited' as const, email });

		try {
			await getAuth().api.signInEmail({
				body: { email, password },
				headers: event.request.headers
			});
		} catch (e) {
			if (e instanceof APIError) {
				return fail(400, { error: 'invalid_credentials' as const, email });
			}
			throw e;
		}

		await clearAttempts(db, key);
		redirect(303, '/admin');
	}
};
