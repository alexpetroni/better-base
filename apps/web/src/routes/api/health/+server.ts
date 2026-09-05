import { json } from '@sveltejs/kit';
import { getChatProvider } from '$lib/modules/chat/server';
import { getSite } from '$lib/server/site';
import type { RequestHandler } from './$types';

/**
 * LIVENESS (FIX-16, audit "Health & logs"): "this process is up and serving
 * this site at this build" — no I/O, so a storage or database blip can never
 * make a load balancer drain an instance that could still serve every page.
 * Point the uptime monitor and the readiness gate at /api/health/ready,
 * which runs the dependency checks. The chat provider kind (FIX-14) is
 * selected at boot, so reporting it costs nothing.
 */
export const GET: RequestHandler = () =>
	json(
		{
			status: 'ok',
			site: getSite().id,
			commit: __BUILD_COMMIT__,
			chatProvider: getChatProvider().kind
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
