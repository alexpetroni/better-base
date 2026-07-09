import { getDb } from '$lib/db';
import { listSubscribers } from '$lib/modules/crm/server';
import type { PageServerLoad } from './$types';

// Admin-only section (enforced by the /admin hook guard via ADMIN_ONLY_SECTIONS).
export const load: PageServerLoad = async ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const subscribers = await listSubscribers({ db: getDb() }, { search });
	return { subscribers, search };
};
