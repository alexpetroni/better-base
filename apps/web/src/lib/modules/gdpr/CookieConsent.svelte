<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { consentCookieString, type CookieConsentValue } from './consent.ts';

	// `initial` is the server-read cookie value: null = not decided yet.
	let { initial }: { initial: CookieConsentValue | null } = $props();

	// The server-read cookie is only the seed; later changes are local decisions.
	// svelte-ignore state_referenced_locally
	let decision = $state(initial);

	function decide(value: CookieConsentValue) {
		document.cookie = consentCookieString(value);
		decision = value;
	}
</script>

{#if decision === null}
	<section
		data-testid="cookie-consent"
		aria-label={m.consent_aria_label()}
		class="fixed inset-x-0 bottom-0 z-50 border-t border-(--color-brand-soft) bg-white p-4 shadow-lg"
	>
		<div class="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
			<p class="text-sm text-(--color-ink)">
				{m.consent_text()}
				<a
					href={resolve('/(public)/pagini/[slug]', { slug: 'politica-de-confidentialitate' })}
					class="underline"
				>
					{m.consent_more()}
				</a>
			</p>
			<div class="flex gap-2">
				<button
					type="button"
					data-testid="consent-deny"
					onclick={() => decide('denied')}
					class="rounded border border-(--color-brand) px-4 py-2 text-sm font-semibold text-(--color-brand) hover:bg-(--color-brand-soft)"
				>
					{m.consent_deny()}
				</button>
				<button
					type="button"
					data-testid="consent-accept"
					onclick={() => decide('granted')}
					class="rounded bg-(--color-brand) px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
				>
					{m.consent_accept()}
				</button>
			</div>
		</div>
	</section>
{/if}

<!--
	Analytics hook point: when an analytics script ships, load it from here —
	only when `analyticsAllowed(decision)` is true — so consent stays enforced
	in exactly one place.
-->
