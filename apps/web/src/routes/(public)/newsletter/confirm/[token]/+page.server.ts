import { getDb } from '$lib/db';
import { confirmSubscriber, getTokenSecret } from '$lib/modules/crm/server';
import { enrollOnConsentConfirmed } from '$lib/modules/nurture/server';
import type { PageServerLoad } from './$types';

// Idempotent by design (confirmed_at is stamped once), so a GET side effect
// is safe even against link prefetchers.
export const load: PageServerLoad = async ({ params }) => {
	const outcome = await confirmSubscriber({ db: getDb() }, getTokenSecret(), params.token);
	if (!outcome.ok) {
		return { status: outcome.error === 'expired' ? ('expired' as const) : ('invalid' as const) };
	}
	// Consent is now confirmed: enroll into matching nurture sequences (also
	// back-fills quiz-triggered ones for results claimed before confirming).
	// Idempotent — a re-click never re-enrolls (unique enrollment).
	await enrollOnConsentConfirmed({ db: getDb() }, outcome.subscriber.id);
	return { status: outcome.already ? ('already' as const) : ('confirmed' as const) };
};
