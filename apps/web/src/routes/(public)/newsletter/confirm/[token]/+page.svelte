<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{m.newsletter_heading()}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-12 text-center">
	{#if data.status === 'confirmed' || data.status === 'already'}
		<p data-testid="confirm-success" class="mb-6 text-lg font-medium text-green-700">
			{m.newsletter_confirm_success()}
		</p>
	{:else}
		<p data-testid="confirm-invalid" class="mb-6 text-lg font-medium text-red-700">
			{m.newsletter_confirm_invalid()}
		</p>
	{/if}
	<a href={resolve('/')} class="text-(--color-brand) hover:underline">{m.error_back_home()}</a>
</div>
