<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	let { title, phase }: { title: string; phase: number } = $props();
</script>

<svelte:head>
	<title>{title}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{title}</h1>
<p data-testid="stub-note" class="text-(--color-ink)/70">
	{m.admin_stub_note({ phase })}
</p>
