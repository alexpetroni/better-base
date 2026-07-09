import { getDb } from '$lib/db';
import { listSubscribers, subscribersCsv } from '$lib/modules/crm/server';
import type { RequestHandler } from './$types';

// Lives under /admin/subscribers/ so the hook guard's admin-only rule applies.
export const GET: RequestHandler = async () => {
	const rows = await listSubscribers({ db: getDb() });
	return new Response(subscribersCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="subscribers.csv"'
		}
	});
};
