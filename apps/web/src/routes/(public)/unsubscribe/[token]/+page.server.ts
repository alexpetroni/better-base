import { getDb } from '$lib/db';
import { unsubscribeByToken } from '$lib/modules/crm/server';
import type { PageServerLoad } from './$types';

// One-click unsubscribe (GDPR): revokes all consents. Idempotent, so the GET
// side effect is safe even against link prefetchers.
export const load: PageServerLoad = async ({ params }) => {
	const subscriber = await unsubscribeByToken({ db: getDb() }, params.token);
	return { done: subscriber !== null };
};
