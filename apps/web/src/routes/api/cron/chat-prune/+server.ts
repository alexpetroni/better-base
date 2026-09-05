import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import { authorizeCron } from '$lib/server/cron';
import { formatRetentionSweep, runRetentionSweep } from '$lib/server/retention';
import type { RequestHandler } from './$types';

/**
 * The retention sweep as an HTTP job, for deploys with no machine to run
 * `pnpm chat:prune` on (Vercel). Scheduled in `vercel.json`; Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`. Same work as the script — both call
 * `runRetentionSweep`.
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

	const result = await runRetentionSweep(getDb());
	// One structured line in the function logs — the only place this job's
	// output is visible on a serverless deploy.
	console.log(formatRetentionSweep(result));
	return json(result, { headers: NO_STORE });
};

const NO_STORE = { 'cache-control': 'no-store' };
