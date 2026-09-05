import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { drainNurtureSends, getNurtureDrainDeps } from '$lib/modules/nurture/server';
import { authorizeCron } from '$lib/server/cron';
import type { RequestHandler } from './$types';

/**
 * Nurture queue drain as an HTTP job (the chat-prune/shipment-sync pattern):
 * scheduled in `vercel.json`, guarded by `authorizeCron` (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`); the machine-cron equivalent is in
 * DEPLOYMENT.md §9. Safe to run twice — the FOR UPDATE SKIP LOCKED claim
 * gives concurrent invocations disjoint batches and the email idempotency
 * key backstops it — and bounded per invocation (serverless time limits):
 * a backlog drains over consecutive runs, oldest due first.
 */
// Serverless budget (audit 2026-09-03 "Ops & platform"): a bounded batch with
// one provider round trip per row needs more than Vercel's 10 s default; 60 s
// is the ceiling every plan allows. adapter-node ignores this export.
export const config = { maxDuration: 60 };

export const GET: RequestHandler = async ({ request }) => {
	const auth = authorizeCron(request.headers.get('authorization'), env.CRON_SECRET);
	if (!auth.ok) {
		return json({ error: auth.reason }, { status: auth.status, headers: NO_STORE });
	}

	const result = await drainNurtureSends(getNurtureDrainDeps());
	// One structured line in the function logs — the only place this job's
	// output is visible on a serverless deploy.
	console.log(
		`nurture-send claimed=${result.claimed} sent=${result.sent} retried=${result.retried} ` +
			`parked=${result.parked} cancelled=${result.cancelled} stale=${result.stale} ` +
			`completed=${result.completed}`
	);
	return json(result, { headers: NO_STORE });
};

const NO_STORE = { 'cache-control': 'no-store' };
