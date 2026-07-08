<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();

	// Placeholder stats; real numbers arrive with each module's phase.
	const stats = [
		{ label: m.admin_nav_articles(), value: '—' },
		{ label: m.admin_nav_quizzes(), value: '—' },
		{ label: m.admin_nav_subscribers(), value: '—' },
		{ label: m.admin_nav_orders(), value: '—' }
	];
</script>

<svelte:head>
	<title>{m.admin_dashboard_heading()} — {data.site.name}</title>
</svelte:head>

<h1 data-testid="admin-dashboard" class="mb-6 text-2xl font-bold">
	{m.admin_dashboard_heading()}
</h1>

<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
	{#each stats as stat (stat.label)}
		<div data-testid="stat-card" class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="text-sm text-(--color-ink)/70">{stat.label}</p>
			<p class="mt-1 text-3xl font-bold text-(--color-brand)">{stat.value}</p>
		</div>
	{/each}
</div>
