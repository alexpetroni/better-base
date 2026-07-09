import { json } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getStorage } from '$lib/modules/media/server';
import { checkHealth } from '$lib/server/health';
import type { RequestHandler } from './$types';

/**
 * A dependency whose singleton cannot even be constructed (missing env) is
 * unhealthy, not a crash: the probe must answer 503 with a structured body,
 * never throw into a 500 (audit resilience #9).
 */
function tryConstruct<T>(construct: () => T): T | null {
	try {
		return construct();
	} catch {
		return null;
	}
}

/** Ops probe: 200 when db + storage are reachable, 503 otherwise. */
export const GET: RequestHandler = async () => {
	const report = await checkHealth({
		db: tryConstruct(getDb),
		storage: tryConstruct(getStorage)
	});
	return json(
		{ status: report.healthy ? 'ok' : 'degraded', checks: report.checks },
		{ status: report.healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
