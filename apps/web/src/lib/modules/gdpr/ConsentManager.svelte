<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import {
		consentCookieString,
		consentFromCookieHeader,
		type CookieConsentValue
	} from './consent.ts';

	// The revocation path (a real GDPR requirement, not just first-visit):
	// rendered on the cookie-policy page so a visitor can change a previous
	// decision. `initial` is the server-read value; `analyticsCookieNames`
	// comes from the selected analytics provider so gdpr never imports the
	// analytics module.
	let {
		initial,
		analyticsCookieNames = []
	}: {
		initial: CookieConsentValue | null;
		analyticsCookieNames?: readonly string[];
	} = $props();

	// Server-read value until mount; the banner may have changed the cookie
	// after this page's server render — the client cookie is the truth.
	let decision = $derived(initial);
	onMount(() => {
		decision = consentFromCookieHeader(document.cookie);
	});

	const status = $derived(
		decision === 'granted'
			? m.consent_status_granted()
			: decision === 'denied'
				? m.consent_status_denied()
				: m.consent_status_none()
	);

	function change(value: CookieConsentValue) {
		document.cookie = consentCookieString(value);
		if (value === 'denied') {
			// Drop whatever the analytics provider set (empty for the
			// cookieless providers, but revocation must not depend on that).
			for (const name of analyticsCookieNames) {
				document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
			}
		}
		// Full reload: removing the script tag would leave an already-executed
		// provider script (and its history listeners) alive — a reload is the
		// only honest "no further requests".
		window.location.reload();
	}
</script>

<section
	data-testid="consent-manager"
	class="mt-8 rounded border border-(--color-brand-soft) bg-(--color-brand-soft)/20 p-4"
>
	<h2 class="text-lg font-semibold">{m.consent_manager_title()}</h2>
	<p data-testid="consent-manager-status" class="mt-1 text-sm text-(--color-ink)/70">
		{status}
	</p>
	<div class="mt-3 flex gap-2">
		<button
			type="button"
			data-testid="consent-manager-accept"
			disabled={decision === 'granted'}
			onclick={() => change('granted')}
			class="rounded bg-(--color-brand) px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
		>
			{m.consent_manager_accept()}
		</button>
		<button
			type="button"
			data-testid="consent-manager-revoke"
			disabled={decision === 'denied'}
			onclick={() => change('denied')}
			class="rounded border border-(--color-brand) px-4 py-2 text-sm font-semibold text-(--color-brand) hover:bg-(--color-brand-soft) disabled:opacity-50"
		>
			{m.consent_manager_revoke()}
		</button>
	</div>
</section>
