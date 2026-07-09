<script lang="ts">
	import { onMount } from 'svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { data, children } = $props();

	// E2E hydration marker: tests must not type into inputs with a server-echoed
	// `value` before hydration, because hydration resets them (see e2e/helpers.ts).
	onMount(() => {
		document.documentElement.dataset.hydrated = 'true';
	});

	const themeStyle = $derived(
		Object.entries(data.site.theme)
			.map(([token, value]) => `--${token}: ${value}`)
			.join('; ')
	);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="min-h-screen bg-(--color-surface) text-(--color-ink)" style={themeStyle}>
	{@render children()}
</div>
