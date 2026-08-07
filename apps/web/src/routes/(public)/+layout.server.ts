import { env as publicEnv } from '$env/dynamic/public';
import { selectAnalyticsProvider } from '$lib/modules/analytics';
import { CONSENT_COOKIE, parseCookieConsent } from '$lib/modules/gdpr';
import { clientSafeSettings } from '$lib/modules/settings';
import { cartCount } from '$lib/modules/shop';
import { readCart } from '$lib/server/cart';
import type { LayoutServerLoad } from './$types';

/**
 * The header cart badge is server-rendered on every public page; the footer's
 * legal block reads site settings. Only settings marked client-safe in the
 * registry ever reach PageData — everything else stays server-only.
 *
 * `analytics` is the selected provider's script config (null = no-op): PUBLIC_*
 * env only, computed here so the client just injects what it is given — and
 * only after `analyticsAllowed(decision)`.
 */
export const load: LayoutServerLoad = async ({ cookies, locals }) => ({
	cartCount: cartCount(readCart(cookies)),
	cookieConsent: parseCookieConsent(cookies.get(CONSENT_COOKIE)),
	publicSettings: clientSafeSettings(await locals.settings()),
	analytics: selectAnalyticsProvider({
		PUBLIC_ANALYTICS_PROVIDER: publicEnv.PUBLIC_ANALYTICS_PROVIDER,
		PUBLIC_ANALYTICS_HOST: publicEnv.PUBLIC_ANALYTICS_HOST,
		PUBLIC_ANALYTICS_SITE_ID: publicEnv.PUBLIC_ANALYTICS_SITE_ID
	})
});
