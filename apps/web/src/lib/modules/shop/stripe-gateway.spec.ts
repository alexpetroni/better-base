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
