// Node-safe barrel (no .svelte imports) for server code and CLI scripts —
// plain `node scripts/*.ts` cannot load Svelte components. The full universal
// barrel (incl. AnalyticsLoader) is ./index.ts.
export {
	ANALYTICS_PROVIDER_KINDS,
	analyticsCookieClearStrings,
	selectAnalyticsProvider,
	type AnalyticsEnv,
	type AnalyticsProviderKind,
	type AnalyticsScriptConfig
} from './select.ts';
