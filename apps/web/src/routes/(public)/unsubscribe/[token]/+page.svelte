<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>{m.unsubscribe_title()}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-12 text-center">
	{#if form?.done}
		<p data-testid="unsubscribe-done" class="mb-6 text-lg font-medium">
			{m.unsubscribe_done()}
		</p>
	{:else if data.valid}
		<!-- The revocation is a POST: opening the link changes nothing. -->
		<form method="POST" data-testid="unsubscribe-form">
			<input type="hidden" name="intent" value="unsubscribe" />
			<p class="mb-6 text-lg font-medium">{m.unsubscribe_confirm_prompt()}</p>
			<button
				type="submit"
				data-testid="unsubscribe-button"
				class="mb-6 rounded bg-(--color-brand) px-5 py-2 font-medium text-white hover:opacity-90"
			>
				{m.unsubscribe_confirm_button()}
			</button>
		</form>
	{:else}
		<p data-testid="unsubscribe-invalid" class="mb-6 text-lg font-medium text-red-700">
			{m.unsubscribe_invalid()}
		</p>
	{/if}
	<a href={resolve('/')} class="text-(--color-brand) hover:underline">{m.error_back_home()}</a>
</div>
