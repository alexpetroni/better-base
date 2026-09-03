import { getDb } from '$lib/db';
import { recordAdminAudit } from '$lib/modules/auth';
import { listSubscribers, subscribersCsv } from '$lib/modules/crm/server';
import { requireAdmin } from '$lib/server/forms';
import type { RequestHandler } from './$types';

// Lives under /admin/subscribers/ so the hook guard's admin-only rule
// applies; requireAdmin is the endpoint's own second layer.
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireAdmin(locals);
	const rows = await listSubscribers({ db: getDb() });
	await recordAdminAudit(getDb(), { actor: user.email, action: 'subscribers-export' });
	return new Response(subscribersCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="subscribers.csv"'
		}
	});
};
