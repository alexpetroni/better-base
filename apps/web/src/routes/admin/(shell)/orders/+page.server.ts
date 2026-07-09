import { getDb } from '$lib/db';
import { listOrders } from '$lib/modules/shop/server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	orders: await listOrders({ db: getDb() })
});
