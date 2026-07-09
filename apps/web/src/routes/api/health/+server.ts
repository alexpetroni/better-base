import { json } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getStorage } from '$lib/modules/media/server';
import { checkHealth } from '$lib/server/health';
import type { RequestHandler } from './$types';

/** Ops probe: 200 when db + storage are reachable, 503 otherwise. */
export const GET: RequestHandler = async () => {
	const report = await checkHealth({ db: getDb(), storage: getStorage() });
	return json(
		{ status: report.healthy ? 'ok' : 'degraded', checks: report.checks },
		{ status: report.healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
