import { getDb } from '$lib/db';
import { isOrderListFilter, listOrders, type OrderListFilter } from '$lib/modules/shop/server';
import type { PageServerLoad } from './$types';

/**
 * The daily work queue: without an explicit `?f=`, show what needs action
 * (paid orders not yet shipped, oversold ones included) instead of the full
 * archive.
 */
export const load: PageServerLoad = async ({ url }) => {
	const raw = url.searchParams.get('f');
	const filter: OrderListFilter = raw !== null && isOrderListFilter(raw) ? raw : 'action';
	return {
		filter,
		orders: await listOrders({ db: getDb() }, filter)
	};
};
