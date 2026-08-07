import { getDb } from '$lib/db';
import { unsubscribeByToken } from '$lib/modules/crm/server';
import { cancelSubscriberNurture } from '$lib/modules/nurture/server';
import type { PageServerLoad } from './$types';

// One-click unsubscribe (GDPR): revokes all consents. Idempotent, so the GET
// side effect is safe even against link prefetchers.
export const load: PageServerLoad = async ({ params }) => {
	const subscriber = await unsubscribeByToken({ db: getDb() }, params.token);
	// Withdrawal stops everything immediately: every pending nurture send for
	// this subscriber, across sequences, is cancelled with the consents.
	if (subscriber) await cancelSubscriberNurture({ db: getDb() }, subscriber.id);
	return { done: subscriber !== null };
};
