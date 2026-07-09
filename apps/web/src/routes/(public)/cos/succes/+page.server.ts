import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getOrderBySessionId, getStripeGateway } from '$lib/modules/shop/server';
import { clearCart } from '$lib/server/cart';
import type { PageServerLoad } from './$types';

export interface SuccessItem {
	name: string;
	qty: number;
	lineTotalCents: number;
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
		return {
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
		state: 'processing' as const,
		email: session.email,
		totalCents: session.amountTotalCents,
		currency: session.currency ?? 'ron',
		items: [] as SuccessItem[]
	};
};
