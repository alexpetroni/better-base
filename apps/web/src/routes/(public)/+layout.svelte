<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';

	let { data, children } = $props();
</script>

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
