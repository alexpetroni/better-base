import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { findSubscriberByUnsubscribeToken, unsubscribeByToken } from '$lib/modules/crm/server';
import { cancelSubscriberNurture } from '$lib/modules/nurture/server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Unsubscribe (GDPR withdrawal). GET only renders the confirmation page — mail
 * scanners (Safe Links, Gmail, Apple MPP) fetch every link in a message, so a
 * GET side effect unsubscribed such mailboxes (audit 2026-09-03 P1). The
 * revocation happens on POST: the page's button, or the RFC 8058 one-click
 * POST (`List-Unsubscribe=One-Click`, urlencoded, no Origin) that mail clients
 * send to the very same URL — which is why this route is the one exemption in
 * the hook-level CSRF origin check (src/lib/server/csrf.ts).
 */
export const load: PageServerLoad = async ({ params }) => {
	const subscriber = await findSubscriberByUnsubscribeToken({ db: getDb() }, params.token);
	return { valid: subscriber !== null };
};

export const actions: Actions = {
	default: async ({ params, request }) => {
		const form = await request.formData();
		const oneClick = form.get('List-Unsubscribe') === 'One-Click';
		if (!oneClick && form.get('intent') !== 'unsubscribe') return fail(400, { done: false });

		const subscriber = await unsubscribeByToken({ db: getDb() }, params.token);
		if (!subscriber) return fail(404, { done: false });
		// Withdrawal stops everything immediately: every pending nurture send for
		// this subscriber, across sequences, is cancelled with the consents.
		await cancelSubscriberNurture({ db: getDb() }, subscriber.id);
		return { done: true };
	}
};
