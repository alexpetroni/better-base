import { getDb } from '$lib/db';
import { confirmSubscriber, getTokenSecret } from '$lib/modules/crm/server';
import type { PageServerLoad } from './$types';

// Idempotent by design (confirmed_at is stamped once), so a GET side effect
// is safe even against link prefetchers.
export const load: PageServerLoad = async ({ params }) => {
	const outcome = await confirmSubscriber({ db: getDb() }, getTokenSecret(), params.token);
	if (!outcome.ok) {
		return { status: outcome.error === 'expired' ? ('expired' as const) : ('invalid' as const) };
	}
	return { status: outcome.already ? ('already' as const) : ('confirmed' as const) };
};
