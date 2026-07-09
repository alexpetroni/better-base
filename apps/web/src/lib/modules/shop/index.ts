// Universal module barrel: safe to import from components and client code.
// Services, gateways and everything db/env-bound live behind
// `$lib/modules/shop/server` instead.
export {
	addToCart,
	CART_COOKIE,
	CART_MAX_LINES,
	CART_MAX_QTY,
	cartCount,
	cartTotalCents,
	parseCartCookie,
	removeFromCart,
	serializeCart,
	setCartQty,
	type CartItem
} from './cart.ts';
export { formatCents, parseLeiToCents } from './money.ts';
export type {
	OrderItemRow,
	OrderRow,
	OrderStatus,
	ProductRow,
	ProductStatus,
	ShippingAddress
} from './schema.ts';
