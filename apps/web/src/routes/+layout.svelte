<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { data, children } = $props();

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
	<header class="border-b border-(--color-brand-soft) bg-(--color-brand) text-white">
		<div class="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
			<a href={resolve('/')} class="text-lg font-bold">{data.site.name}</a>
			<nav>
				<ul class="flex gap-4">
					{#each data.site.nav as item (item.href)}
						<li>
							<a href={resolve(item.href as Pathname)} class="hover:underline">{item.label}</a>
						</li>
					{/each}
				</ul>
			</nav>
		</div>
	</header>

	<main class="mx-auto max-w-4xl px-4 py-8">
		{@render children()}
	</main>
</div>

<div style="display:none">
	{#each locales as locale (locale)}
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as Pathname)}>{locale}</a>
	{/each}
</div>
