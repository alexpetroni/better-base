import { getDb } from '$lib/db';
import { listSubscribers, subscribersCsv } from '$lib/modules/crm/server';
import { requireAdmin } from '$lib/server/forms';
import type { RequestHandler } from './$types';

// Lives under /admin/subscribers/ so the hook guard's admin-only rule
// applies; requireAdmin is the endpoint's own second layer.
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	const rows = await listSubscribers({ db: getDb() });
	return new Response(subscribersCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="subscribers.csv"'
		}
	});
};
