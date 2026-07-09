import type { Cookies } from '@sveltejs/kit';
import { CART_COOKIE, parseCartCookie, serializeCart, type CartItem } from '$lib/modules/shop';

/**
 * Cookie glue for the cart: routes read/write through these so the cookie
 * options stay in one place. The cart is server-rendered (header badge, /cos),
 * so the cookie can stay httpOnly.
 */

const CART_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function readCart(cookies: Cookies): CartItem[] {
	return parseCartCookie(cookies.get(CART_COOKIE));
}

export function writeCart(cookies: Cookies, items: CartItem[]): void {
	if (items.length === 0) {
		clearCart(cookies);
		return;
	}
	cookies.set(CART_COOKIE, serializeCart(items), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: CART_MAX_AGE_SECONDS
	});
}

export function clearCart(cookies: Cookies): void {
	cookies.delete(CART_COOKIE, { path: '/' });
}
