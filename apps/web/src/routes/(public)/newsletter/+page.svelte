<script lang="ts">
	import { NewsletterSignup } from '$lib/modules/crm';
	import { m } from '$lib/paraglide/messages';
	import Seo from '$lib/components/Seo.svelte';
	import { canonicalUrl } from '$lib/seo';

	let { data, form } = $props();
</script>

<Seo
	title={m.newsletter_heading()}
	description={m.newsletter_blurb()}
	canonical={canonicalUrl('/newsletter')}
	siteName={data.site.name}
/>

<div class="mx-auto max-w-md py-8">
	{#if form?.status === 'sent'}
		<p
			data-testid="newsletter-status-sent"
			class="rounded bg-green-50 p-4 font-medium text-green-800"
		>
			{m.newsletter_signup_sent()}
		</p>
	{:else if form?.status === 'already'}
		<p data-testid="newsletter-status-already" class="rounded bg-green-50 p-4 text-green-800">
			{m.newsletter_already()}
		</p>
	{:else}
		{#if form?.error === 'email'}
			<p data-testid="newsletter-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
				{m.newsletter_signup_invalid()}
			</p>
		{:else if form?.error === 'consent'}
			<p data-testid="newsletter-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
				{m.newsletter_consent_required()}
			</p>
		{/if}
		<NewsletterSignup source="newsletter-page" />
	{/if}
</div>
