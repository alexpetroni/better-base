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

/**
 * The delivery option chosen in the cart, charged by Stripe on top of the
 * goods as the session's single fixed-amount shipping option. Selection
 * happens in OUR cart (settings-driven radio), so the charged total is fixed
 * at session creation: goods total + `amountCents`.
 */
export interface CheckoutShippingOption {
	/** Customer-facing name, ETA included (e.g. `Curier standard (1-3 zile)`). */
	displayName: string;
	amountCents: number;
	currency: string;
}

export interface CheckoutSessionInput {
	lineItems: CheckoutLineItem[];
	/** May contain Stripe's `{CHECKOUT_SESSION_ID}` placeholder. */
	successUrl: string;
	cancelUrl: string;
	/** Countries shipping may be collected for (Stripe Checkout collects the address). */
	shippingCountries: string[];
	/** Absent only for carts created before shipping existed (NEXT-8). */
	shippingOption?: CheckoutShippingOption;
	metadata: Record<string, string>;
}

export interface CheckoutSessionView {
	id: string;
	url: string | null;
	status: 'open' | 'complete' | 'expired';
	paymentStatus: string;
	/** Grand total as charged: goods + shipping. */
	amountTotalCents: number | null;
	/** The shipping part of the total; null when the session carried none. */
	shippingCents: number | null;
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
