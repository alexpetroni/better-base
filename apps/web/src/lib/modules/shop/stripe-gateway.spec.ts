import { describe, expect, it } from 'vitest';
import { createStripeGateway } from './stripe-gateway.ts';

// Audit Theme C (resilience #3): Stripe calls must be bounded. Before the fix
// the client was constructed bare — stripe-node's 80s default timeout with
// retries on top, so a hung socket pinned checkout/webhook requests.
describe('createStripeGateway timeouts', () => {
	/** A fetch whose request never completes, but that honors its abort signal. */
	const hangingFetch: typeof fetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject((init!.signal as AbortSignal).reason));
		});

	it('fails within the configured timeout when Stripe never responds', async () => {
		const gateway = createStripeGateway('sk_test_not_real', {
			timeoutMs: 50,
			maxNetworkRetries: 0,
			fetchFn: hangingFetch
		});
		await expect(gateway.getPrice('price_x')).rejects.toThrow(/timeout|ETIMEDOUT|connection/i);
	}, 3_000);
});

// FIX-10 (audit P1 "pending orders"): a session created without
// payment_method_types lets any delayed method enabled in the Stripe
// dashboard put orders on the async path. The gateway must send exactly the
// list it is given, and nothing when told to let the dashboard decide.
describe('createStripeGateway payment method types', () => {
	/** Captures the request Stripe would send and answers like a created session. */
	function capturingFetch() {
		const requests: Array<{ url: string; body: string }> = [];
		const fetchFn: typeof fetch = async (url, init) => {
			requests.push({ url: String(url), body: String(init?.body ?? '') });
			return new Response(
				JSON.stringify({
					id: 'cs_test_captured',
					object: 'checkout.session',
					url: 'https://checkout.stripe.com/c/pay/cs_test_captured'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		};
		return { fetchFn, requests };
	}

	const input = {
		lineItems: [{ name: 'Pernă', unitAmountCents: 4990, currency: 'ron', qty: 1 }],
		successUrl: 'https://example.ro/cos/succes?session_id={CHECKOUT_SESSION_ID}',
		cancelUrl: 'https://example.ro/cos',
		shippingCountries: ['RO'],
		metadata: { cart: '[]' }
	};

	it('pins the session to the given methods (card-only by default upstream)', async () => {
		const { fetchFn, requests } = capturingFetch();
		const gateway = createStripeGateway('sk_test_not_real', { maxNetworkRetries: 0, fetchFn });
		const session = await gateway.createCheckoutSession({ ...input, paymentMethodTypes: ['card'] });
		expect(session.id).toBe('cs_test_captured');
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toContain('/v1/checkout/sessions');
		const body = decodeURIComponent(requests[0].body);
		expect(body).toContain('payment_method_types[0]=card');
		expect(body).toContain('mode=payment');
	});

	it('sends no payment_method_types when the operator lets the dashboard decide', async () => {
		const { fetchFn, requests } = capturingFetch();
		const gateway = createStripeGateway('sk_test_not_real', { maxNetworkRetries: 0, fetchFn });
		await gateway.createCheckoutSession(input);
		expect(decodeURIComponent(requests[0].body)).not.toContain('payment_method_types');
	});

	// FIX-11 (audit P1 "Sameday adapter"): the courier needs a recipient phone,
	// so Checkout must collect one — otherwise no order can ever get an AWB.
	it('asks Checkout to collect the recipient phone number', async () => {
		const { fetchFn, requests } = capturingFetch();
		const gateway = createStripeGateway('sk_test_not_real', { maxNetworkRetries: 0, fetchFn });
		await gateway.createCheckoutSession(input);
		expect(decodeURIComponent(requests[0].body)).toContain('phone_number_collection[enabled]=true');
	});
});
