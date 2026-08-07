// Server module barrel: services, gateways and webhook processing. The
// products media reference check is exported here and wired into deleteMedia
// via $lib/server/media-library.ts MEDIA_REFERENCE_CHECKS.
import { env } from '$env/dynamic/private';
import { positiveIntEnv } from '$lib/server/env';
import { selectCourierProvider, type CourierProvider } from './courier.ts';
import type { StripeGateway } from './gateway.ts';
import { createMockCourierProvider } from './mock-courier.ts';
import { createMockStripeGateway } from './mock-gateway.ts';
import { createSamedayCourier, SAMEDAY_TIMEOUT_MS_DEFAULT } from './sameday-courier.ts';
import { createStripeGateway, STRIPE_TIMEOUT_MS_DEFAULT } from './stripe-gateway.ts';

export {
	buildBuyerCompanyMetadata,
	buildCartMetadata,
	BUYER_COMPANY_METADATA_KEY,
	createCheckoutFromCart,
	loadCartDetails,
	parseBuyerCompanyForm,
	parseBuyerCompanyMetadata,
	parseCartMetadata,
	type BuyerCompanyParse,
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
export {
	appendOrderEvent,
	listOrderEvents,
	transitionFulfillment,
	type TransitionActor,
	type TransitionResult
} from './fulfillment-service.ts';
export {
	selectCourierProvider,
	type CourierProvider,
	type CourierSelection,
	type CourierTrackingStatus,
	type CreatedShipment,
	type ShipmentRequest
} from './courier.ts';
export { productsMediaReferenceCheck } from './media-ref.ts';
export {
	createMockCourierProvider,
	mockLabelPdf,
	type MockCourierProvider
} from './mock-courier.ts';
export { createMockStripeGateway, type MockStripeGateway } from './mock-gateway.ts';
export { orderLookupUrl } from './order-link.ts';
export {
	createSamedayCourier,
	normalizeSamedayStatus,
	samedayTrackingUrl,
	type SamedayCourierOptions
} from './sameday-courier.ts';
export {
	cancelShipmentBestEffort,
	createShipmentForOrder,
	ensureShipmentLabel,
	getShipmentForOrder,
	SHIPMENT_SYNC_ACTOR,
	SHIPMENT_SYNC_BATCH,
	shipmentLabelKey,
	syncShipmentStatuses,
	type CreateShipmentDeps,
	type CreateShipmentError,
	type ShipmentDeps,
	type ShipmentSyncResult
} from './shipment-service.ts';
export {
	buildShippingMetadata,
	parseShippingMetadata,
	SHIPPING_METADATA_KEY,
	type ShippingMetadata
} from './shipping.ts';
export { orderEvents, orderItems, orders, productPillars, products, shipments } from './schema.ts';
export {
	createProduct,
	getProduct,
	getProductBySlug,
	isOutOfStock,
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
export { createStripeGateway, type StripeGatewayOptions } from './stripe-gateway.ts';
export { syncProductToStripe, type SyncDeps, type SyncOutcome } from './sync.ts';
export {
	getOrderBySessionId,
	getOrderWithItems,
	isOrderListFilter,
	listOrders,
	ORDER_LIST_FILTERS,
	processStripeEvent,
	verifyStripeEvent,
	WEBHOOK_ACTOR,
	type OrderListFilter,
	type OrderListRow,
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

let courierInstance: CourierProvider | undefined;

// Explicit pick: $env/dynamic/private only DECLARES keys present in .env, so
// passing `env` directly would not typecheck on a machine without them set.
function courierEnv() {
	return {
		COURIER_PROVIDER: env.COURIER_PROVIDER,
		SAMEDAY_USERNAME: env.SAMEDAY_USERNAME,
		SAMEDAY_PASSWORD: env.SAMEDAY_PASSWORD,
		SAMEDAY_PICKUP_POINT: env.SAMEDAY_PICKUP_POINT,
		SAMEDAY_BASE_URL: env.SAMEDAY_BASE_URL
	};
}

/**
 * The app's courier: the real Sameday adapter ONLY when COURIER_PROVIDER=
 * sameday AND its credentials are set; the deterministic in-memory mock
 * otherwise — dev, vitest and e2e all run on the mock, so no test can call a
 * courier API. Selection is validated at module init (below), so a half-set
 * live config refuses to boot instead of failing on the first AWB.
 */
export function getCourierProvider(): CourierProvider {
	if (!courierInstance) {
		const selection = selectCourierProvider(courierEnv());
		courierInstance =
			selection.kind === 'sameday'
				? createSamedayCourier({
						username: selection.username,
						password: selection.password,
						pickupPoint: selection.pickupPoint,
						baseUrl: selection.baseUrl,
						serviceId: positiveIntEnv(env.SAMEDAY_SERVICE_ID, 0) || undefined,
						timeoutMs: positiveIntEnv(env.SAMEDAY_TIMEOUT_MS, SAMEDAY_TIMEOUT_MS_DEFAULT)
					})
				: createMockCourierProvider();
	}
	return courierInstance;
}

// Fail fast at boot (the chat-provider pattern): COURIER_PROVIDER=sameday
// without complete credentials must refuse to start, never silently mock.
selectCourierProvider(courierEnv());
