import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import {
	invoiceDocPath,
	listInvoicesForOrder,
	signInvoiceDocToken,
	type InvoiceDocFormat
} from '$lib/modules/invoice/server';
import { getOrderBySessionId, getStripeGateway } from '$lib/modules/shop/server';
import { clearCart } from '$lib/server/cart';
import { tokenSecretFrom } from '$lib/server/secrets';
import type { PageServerLoad } from './$types';

export interface SuccessItem {
	name: string;
	qty: number;
	lineTotalCents: number;
}

export interface SuccessInvoiceDoc {
	kind: 'invoice' | 'storno';
	displayNumber: string;
	pdfUrl: string;
	xmlUrl: string;
}

/**
 * Stripe redirects here with ?session_id=…. The order itself is created by
 * the webhook, which may lag the redirect by moments — so we show the order
 * when it exists and a "payment started" summary from the session otherwise.
 */
export const load: PageServerLoad = async ({ url, cookies }) => {
	const sessionId = url.searchParams.get('session_id');
	if (!sessionId) redirect(303, '/cos');

	const found = await getOrderBySessionId({ db: getDb() }, sessionId);
	if (found) {
		clearCart(cookies);
		// Knowing the (unguessable) session id IS the buyer's proof of claim to
		// this order, so short-lived signed download links for its fiscal
		// documents are minted here — and only here. The email links back to
		// this page, which makes the access durable without an account.
		const secret = tokenSecretFrom(env);
		const now = new Date();
		const docUrl = (invoiceId: string, format: InvoiceDocFormat) =>
			invoiceDocPath(invoiceId, format, signInvoiceDocToken(secret, invoiceId, format, now));
		const invoiceDocs = (await listInvoicesForOrder({ db: getDb() }, found.order.id)).map(
			(doc): SuccessInvoiceDoc => ({
				kind: doc.kind,
				displayNumber: doc.displayNumber,
				pdfUrl: docUrl(doc.id, 'pdf'),
				xmlUrl: docUrl(doc.id, 'xml')
			})
		);
		return {
			invoiceDocs,
			// Overrides the layout's badge count — the layout load may have read
			// the cookie before clearCart in this same request (see App.PageData).
			cartCount: 0,
			state: 'order' as const,
			email: found.order.email,
			totalCents: found.order.amountTotalCents,
			currency: found.order.currency,
			items: found.items.map((item): SuccessItem => ({
				name: item.name,
				qty: item.qty,
				lineTotalCents: item.priceCents * item.qty
			}))
		};
	}

	// No order yet: the session must at least be known to the gateway.
	const session = await getStripeGateway().getCheckoutSession(sessionId);
	if (!session) error(404);
	clearCart(cookies);
	return {
		invoiceDocs: [] as SuccessInvoiceDoc[],
		cartCount: 0,
		state: 'processing' as const,
		email: session.email,
		totalCents: session.amountTotalCents,
		currency: session.currency ?? 'ron',
		items: [] as SuccessItem[]
	};
};
