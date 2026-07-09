import Stripe from 'stripe';
import type { CheckoutSessionView, StripeGateway } from './gateway.ts';

/**
 * The real Stripe-backed gateway. Framework-free (the secret key is passed
 * in); only ever constructed when STRIPE_SECRET_KEY is set — tests and dev
 * default to the mock. Test-mode keys (`sk_test_…`) are expected outside prod.
 */
export function createStripeGateway(secretKey: string): StripeGateway {
	const stripe = new Stripe(secretKey);

	return {
		async createProduct(input) {
			const product = await stripe.products.create({
				name: input.name,
				description: input.description || undefined
			});
			return product.id;
		},

		async updateProduct(productId, input) {
			await stripe.products.update(productId, {
				name: input.name,
				description: input.description || undefined
			});
		},

		async createPrice(input) {
			const price = await stripe.prices.create({
				product: input.productId,
				unit_amount: input.unitAmountCents,
				currency: input.currency
			});
			return price.id;
		},

		async archivePrice(priceId) {
			await stripe.prices.update(priceId, { active: false });
		},

		async getPrice(priceId) {
			try {
				const price = await stripe.prices.retrieve(priceId);
				return { unitAmountCents: price.unit_amount ?? 0, currency: price.currency };
			} catch (err) {
				if (err instanceof Stripe.errors.StripeInvalidRequestError) return null;
				throw err;
			}
		},

		async createCheckoutSession(input) {
			const session = await stripe.checkout.sessions.create({
				mode: 'payment',
				line_items: input.lineItems.map((li) => ({
					quantity: li.qty,
					price_data: {
						currency: li.currency,
						unit_amount: li.unitAmountCents,
						product_data: { name: li.name }
					}
				})),
				success_url: input.successUrl,
				cancel_url: input.cancelUrl,
				shipping_address_collection: {
					// Site config lists plain ISO country codes; Stripe's type is a
					// closed enum union of the same codes.
					allowed_countries:
						input.shippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[]
				},
				metadata: input.metadata
			});
			if (!session.url) throw new Error('Stripe did not return a Checkout URL');
			return { id: session.id, url: session.url };
		},

		async getCheckoutSession(sessionId) {
			let session: Stripe.Checkout.Session;
			try {
				session = await stripe.checkout.sessions.retrieve(sessionId);
			} catch (err) {
				if (err instanceof Stripe.errors.StripeInvalidRequestError) return null;
				throw err;
			}
			return sessionView(session);
		}
	};
}

function sessionView(session: Stripe.Checkout.Session): CheckoutSessionView {
	return {
		id: session.id,
		url: session.url,
		status: session.status ?? 'open',
		paymentStatus: session.payment_status,
		amountTotalCents: session.amount_total,
		currency: session.currency,
		email: session.customer_details?.email ?? null,
		metadata: session.metadata ?? {}
	};
}
