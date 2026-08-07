import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import { getCourierProvider, syncShipmentStatuses } from '$lib/modules/shop/server';
import { authorizeCron } from '$lib/server/cron';
import type { RequestHandler } from './$types';

/**
 * Shipment-status poll as an HTTP job (the chat-prune pattern): scheduled in
 * `vercel.json`, guarded by `authorizeCron` (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`); the machine-cron equivalent is in
 * DEPLOYMENT.md §9. Safe to run twice — an unchanged status writes nothing —
 * and bounded per invocation (serverless time limits): a backlog larger than
 * the batch simply drains over consecutive runs, oldest-synced first.
 */
export const GET: RequestHandler = async ({ request }) => {
	const auth = authorizeCron(request.headers.get('authorization'), env.CRON_SECRET);
	if (!auth.ok) {
		return json({ error: auth.reason }, { status: auth.status, headers: NO_STORE });
	}

	const result = await syncShipmentStatuses({ db: getDb(), courier: getCourierProvider() });
	// One structured line in the function logs — the only place this job's
	// output is visible on a serverless deploy.
	console.log(
		`shipment-sync polled=${result.polled} updated=${result.updated} errors=${result.errors}`
	);
	return json(result, { headers: NO_STORE });
};

const NO_STORE = { 'cache-control': 'no-store' };
