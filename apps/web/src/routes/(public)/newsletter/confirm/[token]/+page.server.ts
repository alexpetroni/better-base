import { getDb } from '$lib/db';
import {
	confirmSubscriber,
	getTokenSecret,
	verifyNewsletterConfirmToken
} from '$lib/modules/crm/server';
import { enrollOnConsentConfirmed } from '$lib/modules/nurture/server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Double opt-in confirm. Same pattern as the unsubscribe link (audit
 * 2026-09-03 P1): GET only verifies the signed token and shows a button, so a
 * link scanner's prefetch never confirms a subscription; the POST confirms.
 */
export const load: PageServerLoad = async ({ params }) => {
	const status = await verifyNewsletterConfirmToken(
		{ db: getDb() },
		getTokenSecret(),
		params.token
	);
	return { status };
};

export const actions: Actions = {
	default: async ({ params }) => {
		const outcome = await confirmSubscriber({ db: getDb() }, getTokenSecret(), params.token);
		if (!outcome.ok) {
			return { status: outcome.error === 'expired' ? ('expired' as const) : ('invalid' as const) };
		}
		// Consent is now confirmed: enroll into matching nurture sequences (also
		// back-fills quiz-triggered ones for results claimed before confirming).
		// Idempotent — a re-submit never re-enrolls (unique enrollment).
		await enrollOnConsentConfirmed({ db: getDb() }, outcome.subscriber.id);
		return { status: outcome.already ? ('already' as const) : ('confirmed' as const) };
	}
};
