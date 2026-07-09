<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
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

<div style="display:none">
	{#each locales as locale (locale)}
		<!-- Cast to a static route type: the value is a plain pathname and the
		     Pathname union (which now contains dynamic routes) defeats resolve()'s
		     overloads. -->
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as '/')}>{locale}</a>
	{/each}
</div>
