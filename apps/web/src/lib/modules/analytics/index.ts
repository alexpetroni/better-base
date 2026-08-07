// Analytics module: provider seam (no-op default, Plausible/Umami via
// PUBLIC_* env), consent-gated script loader and the PII-safe event helper.
// Everything here is universal — there is no server-only part.
export { default as AnalyticsLoader } from './AnalyticsLoader.svelte';
export { isTrackablePath, shouldLoadAnalytics } from './gate.ts';
export { sanitizeEventProps, track, type EventProps } from './events.ts';
export {
	ANALYTICS_PROVIDER_KINDS,
	analyticsCookieClearStrings,
	selectAnalyticsProvider,
	type AnalyticsEnv,
	type AnalyticsProviderKind,
	type AnalyticsScriptConfig
} from './select.ts';
