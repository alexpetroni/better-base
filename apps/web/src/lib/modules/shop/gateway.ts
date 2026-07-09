/**
 * The Stripe surface the shop uses, as an interface so tests and dev inject a
 * deterministic mock. The REAL implementation (network calls with a secret
 * key) lives in `stripe-gateway.ts`; the mock in `mock-gateway.ts`. Nothing
 * outside those two files talks to the Stripe API.
 */

export interface GatewayProductInput {
	name: string;
	description?: string;
}

/**
 * A checkout line. Sessions are created with inline `price_data` snapshotted
 * from OUR database (the single source of truth for what is charged) rather
 * than referencing synced Stripe price ids — this keeps checkout independent
 * of sync state and immune to catalog drift. The synced product/price mirror
 * (see `sync.ts`) is for the Stripe dashboard and future integrations.
 */
export interface CheckoutLineItem {
	name: string;
	unitAmountCents: number;
	currency: string;
	qty: number;
}

export interface CheckoutSessionInput {
	lineItems: CheckoutLineItem[];
	/** May contain Stripe's `{CHECKOUT_SESSION_ID}` placeholder. */
	successUrl: string;
	cancelUrl: string;
	/** Countries shipping may be collected for (Stripe Checkout collects the address). */
	shippingCountries: string[];
	metadata: Record<string, string>;
}

export interface CheckoutSessionView {
	id: string;
	url: string | null;
	status: 'open' | 'complete' | 'expired';
	paymentStatus: string;
	amountTotalCents: number | null;
	currency: string | null;
	email: string | null;
	metadata: Record<string, string>;
}

export interface StripeGateway {
	/** Create a catalog product; returns the Stripe product id. */
	createProduct(input: GatewayProductInput): Promise<string>;
	updateProduct(productId: string, input: GatewayProductInput): Promise<void>;
	/** Prices are immutable in Stripe: a change means a new price. Returns its id. */
	createPrice(input: {
		productId: string;
		unitAmountCents: number;
		currency: string;
	}): Promise<string>;
	/** Deactivate a replaced price (it stays attached to past sessions). */
	archivePrice(priceId: string): Promise<void>;
	/** Current amount of a price, so the sync can tell whether it changed. */
	getPrice(priceId: string): Promise<{ unitAmountCents: number; currency: string } | null>;
	createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }>;
	getCheckoutSession(sessionId: string): Promise<CheckoutSessionView | null>;
}
