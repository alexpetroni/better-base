// Universal module barrel: safe to import from components and client code.
// Services, gateways and everything db/env-bound live behind
// `$lib/modules/shop/server` instead.
export {
	addToCart,
	CART_COOKIE,
	cartCount,
	cartTotalCents,
	parseCartCookie,
	removeFromCart,
	serializeCart,
	setCartQty,
	type CartItem
} from './cart.ts';
export {
	canTransition,
	FULFILLMENT_STATUSES,
	IllegalTransitionError,
	isFulfillmentStatus,
	legalTransitions,
	type FulfillmentStatus
} from './fulfillment.ts';
export type {
	BuyerCompany,
	OrderEventRow,
	OrderItemRow,
	OrderRow,
	OrderStatus,
	ProductRow,
	ProductStatus,
	ShipmentRow,
	ShipmentStatus,
	ShippingAddress
} from './schema.ts';
export {
	findShippingOption,
	shippingDisplayName,
	shippingOptionsForCart,
	SHIPPING_OPTION_IDS,
	type ShippingOption,
	type ShippingOptionId,
	type ShippingSettings
} from './shipping.ts';
