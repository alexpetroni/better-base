import { CONSENT_COOKIE, parseCookieConsent } from '$lib/modules/gdpr';
import { cartCount } from '$lib/modules/shop';
import { readCart } from '$lib/server/cart';
import type { LayoutServerLoad } from './$types';

/** The header cart badge is server-rendered on every public page. */
export const load: LayoutServerLoad = ({ cookies }) => ({
	cartCount: cartCount(readCart(cookies)),
	cookieConsent: parseCookieConsent(cookies.get(CONSENT_COOKIE))
});
