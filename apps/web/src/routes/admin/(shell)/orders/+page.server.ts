import { getDb } from '$lib/db';
import {
	isOrderListFilter,
	listEmptyCartEvents,
	listOrders,
	listUnmatchedRefunds,
	type OrderListFilter
} from '$lib/modules/shop/server';
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
		orders: await listOrders({ db: getDb() }, filter),
		// Webhook signals that created no order but need a human: refunds
		// waiting for an order that never came, and completed sessions
		// without a cart snapshot (FIX-10).
		unmatchedRefunds: await listUnmatchedRefunds({ db: getDb() }),
		emptyCartEvents: await listEmptyCartEvents({ db: getDb() })
	};
};
