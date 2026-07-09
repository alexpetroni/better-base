import { describe, expect, it } from 'vitest';
import { CART_MAX_LINES } from './cart.ts';
import { buildCartMetadata, parseCartMetadata } from './checkout.ts';

describe('cart metadata', () => {
	it('round-trips the checkout snapshot', () => {
		const lines = [
			{ productId: 'prod-a', qty: 2, priceCents: 4990 },
			{ productId: 'prod-b', qty: 1, priceCents: 12550 }
		];
		expect(parseCartMetadata(buildCartMetadata(lines))).toEqual([
			{ i: 'prod-a', q: 2, p: 4990 },
			{ i: 'prod-b', q: 1, p: 12550 }
		]);
	});

	it('stays comfortably inside Stripe metadata limits (500 chars per value)', () => {
		const lines = Array.from({ length: CART_MAX_LINES }, () => ({
			productId: crypto.randomUUID(),
			qty: 99,
			priceCents: 9999999
		}));
		expect(buildCartMetadata(lines).length).toBeLessThanOrEqual(500);
	});

	it('degrades malformed metadata to an empty list', () => {
		expect(parseCartMetadata(undefined)).toEqual([]);
		expect(parseCartMetadata('')).toEqual([]);
		expect(parseCartMetadata('garbage')).toEqual([]);
		expect(parseCartMetadata('{"i":"a"}')).toEqual([]);
		expect(parseCartMetadata('[{"i":"a","q":0,"p":100}]')).toEqual([]);
		expect(parseCartMetadata('[{"i":"a","q":1.5,"p":100}]')).toEqual([]);
		expect(parseCartMetadata('[{"i":"a","q":1,"p":-1}]')).toEqual([]);
	});
});
