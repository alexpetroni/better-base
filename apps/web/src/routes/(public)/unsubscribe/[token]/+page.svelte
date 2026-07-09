<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{m.unsubscribe_title()}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-12 text-center">
	{#if data.done}
		<p data-testid="unsubscribe-done" class="mb-6 text-lg font-medium">
			{m.unsubscribe_done()}
		</p>
	{:else}
		<p data-testid="unsubscribe-invalid" class="mb-6 text-lg font-medium text-red-700">
			{m.unsubscribe_invalid()}
		</p>
	{/if}
	<a href={resolve('/')} class="text-(--color-brand) hover:underline">{m.error_back_home()}</a>
</div>
