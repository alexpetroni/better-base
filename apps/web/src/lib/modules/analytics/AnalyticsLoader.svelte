<script lang="ts">
	import type { CookieConsentValue } from '$lib/modules/gdpr';
	import { shouldLoadAnalytics } from './gate.ts';
	import type { AnalyticsScriptConfig } from './select.ts';

	// Mounted ONLY by the (public) layout, so admin/api routes never load the
	// script. `decision` is reactive: granting consent in the banner injects
	// the script without a reload; leaving the public layout (or a consent
	// flip) removes it. True revocation goes through ConsentManager, which
	// reloads the page so an already-executed provider script is fully gone.
	let {
		config,
		decision
	}: { config: AnalyticsScriptConfig | null; decision: CookieConsentValue | null } = $props();

	$effect(() => {
		if (!config || !shouldLoadAnalytics(config, decision, window.location.pathname)) return;
		const script = document.createElement('script');
		script.defer = true;
		script.src = config.src;
		script.dataset.analytics = config.kind;
		for (const [name, value] of Object.entries(config.attrs)) {
			script.setAttribute(name, value);
		}
		document.head.appendChild(script);
		return () => script.remove();
	});
</script>
