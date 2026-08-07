/**
 * Analytics provider selection — the same seam pattern as `ChatProvider` /
 * `StripeGateway`: no config means the no-op default (nothing ships), a real
 * provider is selected ONLY when its env config is fully present, and a
 * half-configured provider is a hard error, never a silent fallback.
 *
 * Pure and serializable on purpose: the server computes the script config
 * from `PUBLIC_*` env (the only env the client may read) and ships it through
 * the (public) layout data; the client injects the script ONLY after
 * `analyticsAllowed(decision)` — see `AnalyticsLoader.svelte`.
 *
 * Both supported providers (Plausible, Umami) are privacy-friendly and run
 * cookieless, so `cookieNames` is empty today; it exists so consent
 * revocation can drop whatever a future provider sets, and the cookie
 * inventory spec fails if a provider ever declares a cookie that is not in
 * the policy.
 */
export interface AnalyticsEnv {
	PUBLIC_ANALYTICS_PROVIDER?: string;
	/** Origin of the analytics service, e.g. `https://plausible.io` or a self-hosted instance. */
	PUBLIC_ANALYTICS_HOST?: string;
	/** Plausible `data-domain` / Umami `data-website-id`. */
	PUBLIC_ANALYTICS_SITE_ID?: string;
}

export const ANALYTICS_PROVIDER_KINDS = ['plausible', 'umami'] as const;
export type AnalyticsProviderKind = (typeof ANALYTICS_PROVIDER_KINDS)[number];

export interface AnalyticsScriptConfig {
	kind: AnalyticsProviderKind;
	src: string;
	attrs: Record<string, string>;
	cookieNames: readonly string[];
}

/** `null` = the no-op provider: nothing is injected, nothing is tracked. */
export function selectAnalyticsProvider(env: AnalyticsEnv): AnalyticsScriptConfig | null {
	const requested = env.PUBLIC_ANALYTICS_PROVIDER?.trim() || 'none';
	if (requested === 'none') return null;
	if (!(ANALYTICS_PROVIDER_KINDS as readonly string[]).includes(requested)) {
		throw new Error(
			`Unknown PUBLIC_ANALYTICS_PROVIDER "${requested}". Expected "plausible" or "umami".`
		);
	}
	const host = env.PUBLIC_ANALYTICS_HOST?.trim().replace(/\/$/, '');
	const siteId = env.PUBLIC_ANALYTICS_SITE_ID?.trim();
	if (!host || !siteId) {
		throw new Error(
			`PUBLIC_ANALYTICS_PROVIDER=${requested} requires PUBLIC_ANALYTICS_HOST and PUBLIC_ANALYTICS_SITE_ID to be set`
		);
	}
	if (requested === 'plausible') {
		return {
			kind: 'plausible',
			src: `${host}/js/script.js`,
			attrs: { 'data-domain': siteId },
			cookieNames: []
		};
	}
	return {
		kind: 'umami',
		src: `${host}/script.js`,
		attrs: { 'data-website-id': siteId },
		cookieNames: []
	};
}

/**
 * `document.cookie` assignment strings that expire every cookie the selected
 * provider sets — executed on consent revocation.
 */
export function analyticsCookieClearStrings(config: AnalyticsScriptConfig | null): string[] {
	return (config?.cookieNames ?? []).map((name) => `${name}=; Max-Age=0; Path=/; SameSite=Lax`);
}
