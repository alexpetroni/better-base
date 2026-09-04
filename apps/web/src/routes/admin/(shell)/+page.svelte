<script lang="ts">
	import { resolve } from '$app/paths';
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

{#if data.shipmentSync.failing > 0}
	<!-- FIX-11: a courier sync that keeps failing must not stay a log line. -->
	<div
		role="alert"
		data-testid="shipment-sync-failing"
		class="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
	>
		<p class="font-semibold">
			{m.admin_dashboard_sync_failing({ count: data.shipmentSync.failing })}
		</p>
		{#if data.shipmentSync.latestError}
			<p class="mt-1 font-mono text-xs break-all" data-testid="shipment-sync-failing-error">
				{data.shipmentSync.latestError}
			</p>
		{/if}
		{#if data.user.role === 'admin'}
			<a href={resolve('/admin/orders')} class="mt-2 inline-block underline">
				{m.admin_dashboard_sync_failing_link()}
			</a>
		{/if}
	</div>
{/if}

<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
	{#each stats as stat (stat.label)}
		<div data-testid="stat-card" class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="text-sm text-(--color-ink)/70">{stat.label}</p>
			<p class="mt-1 text-3xl font-bold text-(--color-brand)">{stat.value}</p>
		</div>
	{/each}
</div>
