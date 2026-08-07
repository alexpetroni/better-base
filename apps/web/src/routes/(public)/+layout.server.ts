import { CONSENT_COOKIE, parseCookieConsent } from '$lib/modules/gdpr';
import { clientSafeSettings } from '$lib/modules/settings';
import { cartCount } from '$lib/modules/shop';
import { readCart } from '$lib/server/cart';
import type { LayoutServerLoad } from './$types';

/**
 * The header cart badge is server-rendered on every public page; the footer's
 * legal block reads site settings. Only settings marked client-safe in the
 * registry ever reach PageData — everything else stays server-only.
 */
export const load: LayoutServerLoad = async ({ cookies, locals }) => ({
	cartCount: cartCount(readCart(cookies)),
	cookieConsent: parseCookieConsent(cookies.get(CONSENT_COOKIE)),
	publicSettings: clientSafeSettings(await locals.settings())
});
