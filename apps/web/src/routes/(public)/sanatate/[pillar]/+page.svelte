<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.pillar.name} · {data.site.name}</title>
</svelte:head>

<h1 class="mb-2 text-3xl font-bold" data-testid="pillar-title">{data.pillar.name}</h1>
<p class="mb-8 text-lg">{data.pillar.description}</p>

<p class="rounded-lg border border-(--color-brand-soft) bg-white p-4 text-sm">
	{m.pillar_placeholder()}
</p>
