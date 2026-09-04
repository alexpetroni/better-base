import { getDb } from '$lib/db';
import { shipmentSyncHealth } from '$lib/modules/shop/server';
import type { PageServerLoad } from './$types';

/**
 * The dashboard's one operational signal (FIX-11): a courier status sync
 * that keeps failing must not stay a log line — the shell shows a banner
 * while in-flight shipments carry `error_count > 0`.
 */
export const load: PageServerLoad = async () => ({
	shipmentSync: await shipmentSyncHealth({ db: getDb() })
});
