<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
</script>

<svelte:head>
	<title>{page.status}</title>
</svelte:head>

<div class="py-16 text-center">
	<h1 class="mb-2 text-4xl font-bold">{page.status}</h1>
	<p class="mb-6 text-lg">
		{page.status === 404 ? m.error_not_found() : m.error_generic()}
	</p>
	<a href={resolve('/')} class="font-medium text-(--color-brand) underline">{m.error_back_home()}</a
	>
	{#if page.error?.errorId}
		<p class="mt-8 text-xs text-(--color-ink)/50" data-testid="error-id">
			ID: {page.error.errorId}
		</p>
	{/if}
</div>
