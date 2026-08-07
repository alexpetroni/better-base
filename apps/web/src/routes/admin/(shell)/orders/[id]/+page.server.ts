import { error, fail } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import { getEmailSender } from '$lib/modules/email/server';
import {
	ensureInvoicesForOrder,
	invoicePdfAttachmentForOrder,
	listInvoicesForOrder
} from '$lib/modules/invoice/server';
import { getStorage } from '$lib/modules/media/server';
import { isFulfillmentStatus } from '$lib/modules/shop';
import {
	createShipmentForOrder,
	getCourierProvider,
	getOrderWithItems,
	getShipmentForOrder,
	listOrderEvents,
	orderLookupUrl,
	transitionFulfillment
} from '$lib/modules/shop/server';
import { formStr } from '$lib/server/forms';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getOrderWithItems({ db: getDb() }, params.id);
	if (!found) error(404);
	return {
		...found,
		events: await listOrderEvents({ db: getDb() }, params.id),
		invoices: await listInvoicesForOrder({ db: getDb() }, params.id),
		shipment: (await getShipmentForOrder({ db: getDb() }, params.id)) ?? null,
		// One nonce per rendered page: the re-send form posts it back and the
		// email idempotency key derives from (invoice id, nonce), so a double
		// submit of the SAME form sends exactly one email, while a fresh page
		// (fresh nonce) is a deliberate new delivery.
		resendNonce: crypto.randomUUID()
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
	},

	/**
	 * Register the order's AWB with the courier and move fulfillment to
	 * `shipped` (via `packed`) — the whole unit is idempotent: the service
	 * holds the order row lock and the unique shipment-per-order index, so a
	 * double click returns the existing AWB instead of creating a second one.
	 * The shipping email goes out once per AWB. Same defense-in-depth admin
	 * check as the other actions.
	 */
	generateAwb: async ({ params, locals }) => {
		if (locals.user?.role !== 'admin') error(403);

		const result = await createShipmentForOrder(
			{
				db: getDb(),
				courier: getCourierProvider(),
				email: getEmailSender(),
				siteName: getSite().name,
				publicBaseUrl: publicEnv.PUBLIC_SITE_URL
			},
			params.id,
			locals.user.email
		);
		if (!result.ok) {
			if (result.error === 'order-not-found') error(404);
			return fail(400, { awbError: result.error, awbDetail: result.detail ?? '' });
		}
		return { awbGenerated: true, awbExisting: !result.value.created };
	},

	/**
	 * Re-send the invoice email (PDF attached) to the buyer. Idempotent per
	 * rendered form via the page nonce (see the load comment); the same
	 * defense-in-depth admin check as the other actions.
	 */
	resendInvoice: async ({ request, params, locals }) => {
		if (locals.user?.role !== 'admin') error(403);

		const form = await request.formData();
		const nonce = formStr(form, 'nonce');
		if (!/^[0-9a-f-]{36}$/.test(nonce)) return fail(400, { resendError: 'invalid-nonce' as const });

		const db = getDb();
		const found = await getOrderWithItems({ db }, params.id);
		if (!found) error(404);
		if (!found.order.email) return fail(400, { resendError: 'no-email' as const });

		const info = await invoicePdfAttachmentForOrder({ db, storage: getStorage() }, params.id);
		if (!info) return fail(400, { resendError: 'no-invoice' as const });

		const outcome = await getEmailSender().send({
			to: found.order.email,
			template: 'invoice-email',
			data: {
				siteName: getSite().name,
				invoiceNumber: info.displayNumber,
				orderUrl:
					publicEnv.PUBLIC_SITE_URL && found.order.stripeSessionId
						? orderLookupUrl(publicEnv.PUBLIC_SITE_URL, found.order.stripeSessionId)
						: undefined
			},
			attachments: [info.attachment],
			idempotencyKey: `invoice-email:${info.invoiceId}:${nonce}`
		});
		if (outcome.status === 'error') {
			return fail(500, { resendError: 'send-failed' as const });
		}
		return { invoiceResent: true, resendSkipped: outcome.status === 'skipped' };
	}
};
