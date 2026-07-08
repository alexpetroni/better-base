import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { getDb } from '$lib/db';
import {
	clearAttempts,
	getAttemptState,
	getAuth,
	isRateLimited,
	rateLimitKey,
	recordFailure,
	saveAttemptState
} from '$lib/modules/auth';
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
		const now = new Date();
		const state = await getAttemptState(db, key);
		if (isRateLimited(state, now)) return fail(429, { error: 'rate_limited' as const, email });

		try {
			await getAuth().api.signInEmail({
				body: { email, password },
				headers: event.request.headers
			});
		} catch (e) {
			if (e instanceof APIError) {
				await saveAttemptState(db, key, recordFailure(state, now));
				return fail(400, { error: 'invalid_credentials' as const, email });
			}
			throw e;
		}

		await clearAttempts(db, key);
		redirect(303, '/admin');
	}
};
