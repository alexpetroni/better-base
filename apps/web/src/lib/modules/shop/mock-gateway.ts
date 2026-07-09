import { cartTotalCents } from './cart.ts';
import type {
	CheckoutSessionInput,
	CheckoutSessionView,
	GatewayProductInput,
	StripeGateway
} from './gateway.ts';

/**
 * Deterministic in-memory Stripe stand-in: the dev/test default (selected
 * whenever STRIPE_SECRET_KEY is unset). Ids are sequential, sessions live in
 * a map so the success page can retrieve what checkout created — within one
 * process, which is exactly the preview-server/e2e situation.
 */

export interface MockStripeGateway extends StripeGateway {
	/** Test hooks: everything the mock has recorded so far. */
	readonly products: Map<string, GatewayProductInput>;
	readonly prices: Map<string, { productId: string; unitAmountCents: number; currency: string }>;
	readonly archivedPrices: Set<string>;
	readonly sessions: Map<string, CheckoutSessionView & { input: CheckoutSessionInput }>;
}

export const MOCK_CHECKOUT_URL_BASE = 'https://checkout.stripe.com/c/pay';

export function createMockStripeGateway(): MockStripeGateway {
	let seq = 0;
	const next = (prefix: string) => `${prefix}_mock_${++seq}`;
	const products = new Map<string, GatewayProductInput>();
	const prices = new Map<string, { productId: string; unitAmountCents: number; currency: string }>();
	const archivedPrices = new Set<string>();
	const sessions = new Map<string, CheckoutSessionView & { input: CheckoutSessionInput }>();

	return {
		products,
		prices,
		archivedPrices,
		sessions,

		async createProduct(input) {
			const id = next('prod');
			products.set(id, input);
			return id;
		},

		async updateProduct(productId, input) {
			if (!products.has(productId)) throw new Error(`Mock Stripe: no product ${productId}`);
			products.set(productId, input);
		},

		async createPrice(input) {
			const id = next('price');
			prices.set(id, input);
			return id;
		},

		async archivePrice(priceId) {
			archivedPrices.add(priceId);
		},

		async getPrice(priceId) {
			const price = prices.get(priceId);
			return price ? { unitAmountCents: price.unitAmountCents, currency: price.currency } : null;
		},

		async createCheckoutSession(input) {
			const id = `cs_test_mock_${++seq}`;
			const lines = input.lineItems.map((li) => ({ priceCents: li.unitAmountCents, qty: li.qty }));
			const url = `${MOCK_CHECKOUT_URL_BASE}/${id}`;
			sessions.set(id, {
				id,
				url,
				status: 'open',
				paymentStatus: 'unpaid',
				amountTotalCents: cartTotalCents(lines),
				currency: input.lineItems[0]?.currency ?? 'ron',
				email: null,
				metadata: input.metadata,
				input
			});
			return { id, url };
		},

		async getCheckoutSession(sessionId) {
			return sessions.get(sessionId) ?? null;
		}
	};
}
