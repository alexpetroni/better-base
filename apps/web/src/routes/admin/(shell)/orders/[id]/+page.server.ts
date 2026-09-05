import { error, fail } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import { getEmailSender } from '$lib/modules/email/server';
import { recordAdminAudit } from '$lib/modules/auth';
import {
	ensureInvoicesForOrder,
	invoicePdfAttachmentForOrder,
	issuePartialStornoForOrder,
	listInvoicesForOrder,
	listParkedSubmissionsForOrder,
	requeueParkedSubmission
} from '$lib/modules/invoice/server';
import { getInvoiceStorage } from '$lib/modules/media/server';
import { isFulfillmentStatus } from '$lib/modules/shop';
import {
	createShipmentForOrder,
	getCourierProvider,
	getOrderWithItems,
	getShipmentForOrder,
	listOrderEvents,
	orderLookupUrl,
	transitionFulfillment,
	updateOrderShippingAddress
} from '$lib/modules/shop/server';
import { formStr, requireAdmin } from '$lib/server/forms';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getOrderWithItems({ db: getDb() }, params.id);
	if (!found) error(404);
	const invoices = await listInvoicesForOrder({ db: getDb() }, params.id);
	return {
		...found,
		events: await listOrderEvents({ db: getDb() }, params.id),
		invoices,
		// What the stornos already reverse (positive bani): the partial-storno
		// button offers exactly refunded_cents − this, and hides at zero.
		reversedCents: invoices
			.filter((doc) => doc.kind === 'storno')
			.reduce((sum, doc) => sum - doc.grossTotalCents, 0),
		// e-Factura submissions parked after EFACTURA_MAX_ATTEMPTS (FIX-17): the
		// page offers the re-queue button next to each.
		parkedSubmissions: await listParkedSubmissionsForOrder({ db: getDb() }, params.id),
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
		const user = requireAdmin(locals);

		const form = await request.formData();
		const to = formStr(form, 'to');
		if (!isFulfillmentStatus(to)) return fail(400, { error: 'invalid-status' as const });

		const result = await transitionFulfillment({ db: getDb() }, params.id, to, {
			actor: user.email,
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
		const user = requireAdmin(locals);

		const result = await ensureInvoicesForOrder({ db: getDb() }, params.id, user.email);
		if (!result.ok) {
			if (result.error === 'order-not-found') error(404);
			return fail(400, { invoiceError: result.error, invoiceDetail: result.detail ?? '' });
		}
		return { invoiceIssued: true };
	},

	/**
	 * The fiscal side of a PARTIAL refund: issue a storno for exactly what
	 * Stripe refunded and no earlier storno has reversed (`refunded_cents −
	 * Σ stornos`). The operator types no amount, so the document cannot
	 * disagree with the money movement; the service locks the order row
	 * against a racing webhook. Same defense-in-depth admin check.
	 */
	stornoPartial: async ({ params, locals }) => {
		const user = requireAdmin(locals);

		const result = await issuePartialStornoForOrder({ db: getDb() }, params.id, user.email);
		if (!result.ok) {
			if (result.error === 'order-not-found') error(404);
			return fail(400, { stornoError: result.error, stornoDetail: result.detail ?? '' });
		}
		return { stornoIssued: true };
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
		const user = requireAdmin(locals);

		const result = await createShipmentForOrder(
			{
				db: getDb(),
				courier: getCourierProvider(),
				email: getEmailSender(),
				siteName: getSite().name,
				publicBaseUrl: publicEnv.PUBLIC_SITE_URL
			},
			params.id,
			user.email
		);
		if (!result.ok) {
			if (result.error === 'order-not-found') error(404);
			return fail(400, { awbError: result.error, awbDetail: result.detail ?? '' });
		}
		return { awbGenerated: true, awbExisting: !result.value.created };
	},

	/**
	 * Operator-typed recipient data (FIX-11): the way out of the
	 * `missing-recipient-data` refusal — the service bounds and validates the
	 * fields and records which ones changed. Same defense-in-depth admin check.
	 */
	updateShippingAddress: async ({ request, params, locals }) => {
		const user = requireAdmin(locals);

		const form = await request.formData();
		const result = await updateOrderShippingAddress(
			{ db: getDb() },
			params.id,
			{
				name: formStr(form, 'name'),
				phone: formStr(form, 'phone'),
				line1: formStr(form, 'line1'),
				line2: formStr(form, 'line2'),
				city: formStr(form, 'city'),
				state: formStr(form, 'state'),
				postalCode: formStr(form, 'postalCode'),
				country: formStr(form, 'country')
			},
			user.email
		);
		if (!result.ok) {
			if (result.error === 'order-not-found') error(404);
			return fail(400, { addressError: result.error, addressDetail: result.detail ?? '' });
		}
		return { addressUpdated: true };
	},

	/**
	 * Re-send the invoice email (PDF attached) to the buyer. Idempotent per
	 * rendered form via the page nonce (see the load comment); the same
	 * defense-in-depth admin check as the other actions.
	 */
	resendInvoice: async ({ request, params, locals }) => {
		requireAdmin(locals);

		const form = await request.formData();
		const nonce = formStr(form, 'nonce');
		if (!/^[0-9a-f-]{36}$/.test(nonce)) return fail(400, { resendError: 'invalid-nonce' as const });

		const db = getDb();
		const found = await getOrderWithItems({ db }, params.id);
		if (!found) error(404);
		if (!found.order.email) return fail(400, { resendError: 'no-email' as const });

		const info = await invoicePdfAttachmentForOrder(
			{ db, storage: getInvoiceStorage() },
			params.id
		);
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
	},

	/**
	 * Re-queue a parked e-Factura submission (FIX-17): back to `pending`, due
	 * now, attempts reset, so the next cron tick claims it — the statutory
	 * 5-day clock does not wait for manual SQL. Scoped to this order's
	 * documents. Same defense-in-depth admin check as the other actions.
	 */
	requeue: async ({ request, params, locals }) => {
		const user = requireAdmin(locals);

		const form = await request.formData();
		const invoiceId = formStr(form, 'invoiceId');
		if (!invoiceId) return fail(400, { requeueError: 'invalid' as const });
		const found = await requeueParkedSubmission({ db: getDb() }, invoiceId, {
			orderId: params.id
		});
		if (!found) return fail(400, { requeueError: 'not-found' as const });
		await recordAdminAudit(getDb(), {
			actor: user.email,
			action: 'efactura-requeue',
			target: invoiceId
		});
		return { requeued: true };
	}
};
