import { describe, expect, it } from 'vitest';
import {
	addToCart,
	CART_MAX_LINES,
	CART_MAX_QTY,
	cartCount,
	cartTotalCents,
	parseCartCookie,
	removeFromCart,
	serializeCart,
	setCartQty
} from './cart.ts';

describe('parseCartCookie', () => {
	it('round-trips a serialized cart', () => {
		const items = [
			{ productId: 'a', qty: 2 },
			{ productId: 'b', qty: 1 }
		];
		expect(parseCartCookie(serializeCart(items))).toEqual(items);
	});

	it('degrades malformed input to an empty cart', () => {
		expect(parseCartCookie(undefined)).toEqual([]);
		expect(parseCartCookie('')).toEqual([]);
		expect(parseCartCookie('not json')).toEqual([]);
		expect(parseCartCookie('{"productId":"a"}')).toEqual([]);
		expect(parseCartCookie('[{"qty":2}]')).toEqual([]);
		expect(parseCartCookie('[{"productId":"a","qty":"2"}]')).toEqual([]);
	});

	it('clamps quantities and drops duplicates and overflow lines', () => {
		expect(parseCartCookie('[{"productId":"a","qty":500}]')).toEqual([
			{ productId: 'a', qty: CART_MAX_QTY }
		]);
		expect(parseCartCookie('[{"productId":"a","qty":0.5}]')).toEqual([{ productId: 'a', qty: 1 }]);
		expect(
			parseCartCookie('[{"productId":"a","qty":1},{"productId":"a","qty":9}]')
		).toEqual([{ productId: 'a', qty: 1 }]);
		const overflow = JSON.stringify(
			Array.from({ length: CART_MAX_LINES + 3 }, (_, i) => ({ productId: `p${i}`, qty: 1 }))
		);
		expect(parseCartCookie(overflow)).toHaveLength(CART_MAX_LINES);
	});
});

describe('cart operations', () => {
	it('addToCart merges lines and clamps at the max quantity', () => {
		let items = addToCart([], 'a', 2);
		items = addToCart(items, 'a', 3);
		expect(items).toEqual([{ productId: 'a', qty: 5 }]);
		expect(addToCart(items, 'a', 200)[0].qty).toBe(CART_MAX_QTY);
	});

	it('addToCart refuses new lines on a full cart but still merges existing ones', () => {
		const full = Array.from({ length: CART_MAX_LINES }, (_, i) => ({
			productId: `p${i}`,
			qty: 1
		}));
		expect(addToCart(full, 'new-product')).toEqual(full);
		expect(addToCart(full, 'p0', 2).find((i) => i.productId === 'p0')?.qty).toBe(3);
	});

	it('setCartQty updates, clamps, and removes at zero', () => {
		const items = [
			{ productId: 'a', qty: 2 },
			{ productId: 'b', qty: 1 }
		];
		expect(setCartQty(items, 'a', 7)).toEqual([
			{ productId: 'a', qty: 7 },
			{ productId: 'b', qty: 1 }
		]);
		expect(setCartQty(items, 'a', 0)).toEqual([{ productId: 'b', qty: 1 }]);
		expect(setCartQty(items, 'a', -3)).toEqual([{ productId: 'b', qty: 1 }]);
	});

	it('removeFromCart drops only the given product', () => {
		const items = [
			{ productId: 'a', qty: 2 },
			{ productId: 'b', qty: 1 }
		];
		expect(removeFromCart(items, 'b')).toEqual([{ productId: 'a', qty: 2 }]);
		expect(removeFromCart(items, 'missing')).toEqual(items);
	});
});

describe('cart math', () => {
	it('cartCount sums units across lines', () => {
		expect(cartCount([])).toBe(0);
		expect(
			cartCount([
				{ productId: 'a', qty: 2 },
				{ productId: 'b', qty: 3 }
			])
		).toBe(5);
	});

	it('cartTotalCents sums qty × unit price in integer cents', () => {
		expect(cartTotalCents([])).toBe(0);
		expect(
			cartTotalCents([
				{ priceCents: 4990, qty: 2 },
				{ priceCents: 12550, qty: 1 }
			])
		).toBe(22530);
	});
});
