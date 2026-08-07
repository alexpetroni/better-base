import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { ensureInvoicesForOrder, listInvoicesForOrder } from '$lib/modules/invoice/server';
import { isFulfillmentStatus } from '$lib/modules/shop';
import {
	getOrderWithItems,
	listOrderEvents,
	transitionFulfillment
} from '$lib/modules/shop/server';
import { formStr } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getOrderWithItems({ db: getDb() }, params.id);
	if (!found) error(404);
	return {
		...found,
		events: await listOrderEvents({ db: getDb() }, params.id),
		invoices: await listInvoicesForOrder({ db: getDb() }, params.id)
	};
};

export const actions: Actions = {
	/**
	 * Apply one legal fulfillment transition. The /admin/orders section is
	 * already admin-only in the route guard; this check keeps the action safe
	 * on its own (defense in depth — a guard regression must not open writes).
	 */
	transition: async ({ request, params, locals }) => {
		if (locals.user?.role !== 'admin') error(403);

		const form = await request.formData();
		const to = formStr(form, 'to');
		if (!isFulfillmentStatus(to)) return fail(400, { error: 'invalid-status' as const });

		const result = await transitionFulfillment({ db: getDb() }, params.id, to, {
			actor: locals.user.email,
			note: formStr(form, 'note').trim()
		});
		if (!result.ok) {
			if (result.error === 'not-found') error(404);
			return fail(400, { error: result.error, from: result.from, to: result.to });
		}
		return { transitioned: true, to };
	},

	/**
	 * One-click (re)issue of the order's missing fiscal documents: the invoice
	 * (when webhook issuance failed, e.g. on incomplete issuer settings) and
	 * the storno for a refunded order. Idempotent — an already-complete order
	 * is a no-op. Same defense-in-depth admin check as `transition`.
	 */
	issueInvoice: async ({ params, locals }) => {
		if (locals.user?.role !== 'admin') error(403);

		const result = await ensureInvoicesForOrder({ db: getDb() }, params.id, locals.user.email);
		if (!result.ok) {
			if (result.error === 'order-not-found') error(404);
			return fail(400, { invoiceError: result.error, invoiceDetail: result.detail ?? '' });
		}
		return { invoiceIssued: true };
	}
};
