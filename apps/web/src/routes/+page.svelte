<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.site.name}</title>
</svelte:head>

<h1 class="mb-2 text-3xl font-bold">{data.site.name}</h1>
<p class="mb-8 text-lg">{m.home_tagline()}</p>

<h2 class="mb-4 text-xl font-semibold">{m.home_pillars_heading()}</h2>
<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
	{#each data.pillars as pillar (pillar.slug)}
		<li data-testid="pillar-item">
			<a
				href={resolve('/sanatate/[pillar]', { pillar: pillar.slug })}
				class="block rounded-lg border border-(--color-brand-soft) bg-white p-4 transition-shadow hover:shadow-md"
			>
				<span class="font-semibold text-(--color-brand)">{pillar.name}</span>
				<p class="mt-1 text-sm text-(--color-ink)/70">{pillar.description}</p>
			</a>
		</li>
	{/each}
</ul>
