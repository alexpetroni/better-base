/**
 * The cart is a plain cookie — no login, no DB row. Only product ids and
 * quantities are stored; prices ALWAYS come from the database at render and
 * checkout time, so a tampered cookie can never change what is charged.
 * Everything here is pure and unit-testable.
 */

export interface CartItem {
	productId: string;
	qty: number;
}

export const CART_COOKIE = 'cart';
export const CART_MAX_QTY = 99;
/**
 * Distinct products per cart. The checkout snapshot travels in Stripe session
 * metadata (500 chars per value): a worst-case line (uuid id, qty 99, 7-digit
 * price) serializes to ~63 chars, so 7 lines always fit.
 */
export const CART_MAX_LINES = 7;

function clampQty(qty: number): number {
	if (!Number.isInteger(qty)) return 1;
	return Math.min(Math.max(qty, 1), CART_MAX_QTY);
}

/** Parse the raw cookie value. Anything malformed degrades to an empty cart. */
export function parseCartCookie(raw: string | undefined): CartItem[] {
	if (!raw) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const items: CartItem[] = [];
	for (const entry of data) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { productId, qty } = entry as Record<string, unknown>;
		if (typeof productId !== 'string' || !productId) continue;
		if (typeof qty !== 'number') continue;
		if (items.some((i) => i.productId === productId)) continue;
		if (items.length >= CART_MAX_LINES) break;
		items.push({ productId, qty: clampQty(qty) });
	}
	return items;
}

export function serializeCart(items: CartItem[]): string {
	return JSON.stringify(items);
}

/** Add qty of a product (merging with an existing line). Full cart → unchanged. */
export function addToCart(items: CartItem[], productId: string, qty = 1): CartItem[] {
	const existing = items.find((i) => i.productId === productId);
	if (existing) {
		return items.map((i) => (i.productId === productId ? { ...i, qty: clampQty(i.qty + qty) } : i));
	}
	if (items.length >= CART_MAX_LINES) return items;
	return [...items, { productId, qty: clampQty(qty) }];
}

/** Set a line's quantity; 0 (or less) removes the line. */
export function setCartQty(items: CartItem[], productId: string, qty: number): CartItem[] {
	if (qty <= 0) return removeFromCart(items, productId);
	return items.map((i) => (i.productId === productId ? { ...i, qty: clampQty(qty) } : i));
}

export function removeFromCart(items: CartItem[], productId: string): CartItem[] {
	return items.filter((i) => i.productId !== productId);
}

/** Total units across all lines — the number shown on the header badge. */
export function cartCount(items: CartItem[]): number {
	return items.reduce((sum, i) => sum + i.qty, 0);
}

/** Sum of unit price × qty in integer cents. */
export function cartTotalCents(lines: Array<{ priceCents: number; qty: number }>): number {
	return lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
}
