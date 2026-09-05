<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data, form } = $props();
	const status = $derived(form?.status ?? data.status);
</script>

<svelte:head>
	<title>{m.newsletter_heading()}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-12 text-center">
	{#if status === 'confirmed' || status === 'already'}
		<p data-testid="confirm-success" class="mb-6 text-lg font-medium text-green-700">
			{m.newsletter_confirm_success()}
		</p>
	{:else if status === 'valid'}
		<!-- Confirmation is a POST: opening the link changes nothing. -->
		<form method="POST" data-testid="confirm-form">
			<p class="mb-6 text-lg font-medium">{m.newsletter_confirm_prompt()}</p>
			<button
				type="submit"
				data-testid="confirm-button"
				class="mb-6 rounded bg-(--color-brand) px-5 py-2 font-medium text-white hover:opacity-90"
			>
				{m.newsletter_confirm_button()}
			</button>
		</form>
	{:else}
		<p data-testid="confirm-invalid" class="mb-6 text-lg font-medium text-red-700">
			{m.newsletter_confirm_invalid()}
		</p>
	{/if}
	<a href={resolve('/')} class="text-(--color-brand) hover:underline">{m.error_back_home()}</a>
</div>
