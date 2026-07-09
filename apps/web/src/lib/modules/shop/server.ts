// Server module barrel: services, gateways, webhook processing and the media
// reference check registration. Loaded from hooks.server.ts so the
// registration below runs before any admin request can delete media.
import { env } from '$env/dynamic/private';
import { registerMediaReferenceCheck } from '$lib/modules/media/server';
import { positiveIntEnv } from '$lib/server/env';
import type { StripeGateway } from './gateway.ts';
import { createMockStripeGateway } from './mock-gateway.ts';
import { productsMediaReferenceCheck } from './media-ref.ts';
import { createStripeGateway, STRIPE_TIMEOUT_MS_DEFAULT } from './stripe-gateway.ts';

export {
	buildCartMetadata,
	CART_METADATA_KEY,
	createCheckoutFromCart,
	loadCartDetails,
	parseCartMetadata,
	type CartDetails,
	type CartLine,
	type CartMetadataItem,
	type CheckoutDeps,
	type CheckoutOutcome
} from './checkout.ts';
export type {
	CheckoutLineItem,
	CheckoutSessionInput,
	CheckoutSessionView,
	GatewayProductInput,
	StripeGateway
} from './gateway.ts';
export { productsMediaReferenceCheck } from './media-ref.ts';
export {
	createMockStripeGateway,
	MOCK_CHECKOUT_URL_BASE,
	type MockStripeGateway
} from './mock-gateway.ts';
export { orderItems, orders, productPillars, products } from './schema.ts';
export {
	createProduct,
	ensureUniqueProductSlug,
	getProduct,
	getProductBySlug,
	isOutOfStock,
	isPurchasable,
	listProducts,
	listVisibleProducts,
	updateProduct,
	type CatalogItem,
	type ProductPatch,
	type ProductWithPillars,
	type ShopDeps,
	type ShopError,
	type ShopResult
} from './service.ts';
export {
	createStripeGateway,
	STRIPE_MAX_NETWORK_RETRIES,
	STRIPE_TIMEOUT_MS_DEFAULT,
	type StripeGatewayOptions
} from './stripe-gateway.ts';
export { syncProductToStripe, type SyncDeps, type SyncOutcome } from './sync.ts';
export {
	decrementedStock,
	getOrderBySessionId,
	getOrderWithItems,
	listOrders,
	processStripeEvent,
	verifyStripeEvent,
	type WebhookDeps,
	type WebhookOutcome
} from './webhook.ts';

let gatewayInstance: StripeGateway | undefined;

/**
 * The app's gateway: real Stripe ONLY when STRIPE_SECRET_KEY is set (use
 * `sk_test_…` outside prod); the deterministic in-memory mock otherwise —
 * dev, vitest and e2e all run on the mock, so no test can call Stripe.
 */
export function getStripeGateway(): StripeGateway {
	gatewayInstance ??= env.STRIPE_SECRET_KEY
		? createStripeGateway(env.STRIPE_SECRET_KEY, {
				timeoutMs: positiveIntEnv(env.STRIPE_TIMEOUT_MS, STRIPE_TIMEOUT_MS_DEFAULT)
			})
		: createMockStripeGateway();
	return gatewayInstance;
}

/** Webhook signing secret (`whsec_…` from Stripe or `stripe listen`). */
export function getStripeWebhookSecret(): string {
	if (!env.STRIPE_WEBHOOK_SECRET) {
		throw new Error('STRIPE_WEBHOOK_SECRET is not set — see .env.example');
	}
	return env.STRIPE_WEBHOOK_SECRET;
}

registerMediaReferenceCheck(productsMediaReferenceCheck);
