<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { formatCents } from '$lib/modules/shop';

	let { data } = $props();

	const statusLabels: Record<string, () => string> = {
		pending: m.admin_order_status_pending,
		paid: m.admin_order_status_paid,
		failed: m.admin_order_status_failed,
		refunded: m.admin_order_status_refunded
	};

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'long', timeStyle: 'short' });

	const shipping = $derived(data.order.shippingAddress);
	const shippingLines = $derived(
		shipping
			? [
					shipping.name,
					shipping.line1,
					shipping.line2,
					[shipping.postalCode, shipping.city].filter(Boolean).join(' '),
					[shipping.state, shipping.country].filter(Boolean).join(', ')
				].filter((line): line is string => !!line)
			: []
	);
</script>

<svelte:head>
	<title>{m.admin_order_heading({ id: data.order.id.slice(0, 8) })} · {m.admin_nav_orders()}</title>
</svelte:head>

<div class="mb-4">
	<a href={resolve('/admin/orders')} class="text-sm text-(--color-brand) hover:underline">
		{m.admin_order_back()}
	</a>
</div>

<div class="mb-6 flex flex-wrap items-center gap-3" data-testid="order-detail">
	<h1 class="text-2xl font-bold">{m.admin_order_heading({ id: data.order.id.slice(0, 8) })}</h1>
	<span
		data-testid="order-detail-status"
		class="rounded px-2 py-0.5 text-xs font-semibold
			{data.order.status === 'paid'
			? 'bg-green-100 text-green-800'
			: data.order.status === 'refunded'
				? 'bg-amber-100 text-amber-800'
				: 'bg-(--color-brand-soft) text-(--color-ink)'}"
	>
		{statusLabels[data.order.status]()}
	</span>
	{#if data.order.oversold}
		<span
			data-testid="order-detail-oversold"
			class="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
			title={m.admin_order_oversold()}
		>
			{m.admin_order_oversold()}
		</span>
	{/if}
</div>

<div class="grid gap-6 lg:grid-cols-[1fr_20rem]">
	<div class="rounded-lg border border-(--color-brand-soft) bg-white">
		<h2 class="border-b border-(--color-brand-soft) px-4 py-3 text-sm font-semibold">
			{m.admin_order_items()}
		</h2>
		<ul class="divide-y divide-(--color-brand-soft)/50">
			{#each data.items as item (item.id)}
				<li class="flex items-center justify-between gap-4 px-4 py-3" data-testid="order-item">
					<span>
						{item.name}
						<span class="text-(--color-ink)/60">×{item.qty}</span>
					</span>
					<span class="font-semibold">
						{formatCents(item.priceCents * item.qty, data.order.currency)}
					</span>
				</li>
			{/each}
			<li class="flex items-center justify-between gap-4 px-4 py-3">
				<span class="font-semibold">{m.cart_total()}</span>
				<strong data-testid="order-detail-total">
					{formatCents(data.order.amountTotalCents, data.order.currency)}
				</strong>
			</li>
		</ul>
	</div>

	<aside class="space-y-4 text-sm">
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-1 text-(--color-ink)/60">{m.admin_orders_col_date()}</p>
			<p>{dateFmt.format(data.order.createdAt)}</p>
			<p class="mt-3 mb-1 text-(--color-ink)/60">{m.admin_orders_col_email()}</p>
			<p data-testid="order-detail-email">{data.order.email}</p>
		</div>
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-1 text-(--color-ink)/60">{m.admin_order_shipping()}</p>
			{#if shippingLines.length > 0}
				<address class="not-italic" data-testid="order-detail-shipping">
					{#each shippingLines as line (line)}
						<span class="block">{line}</span>
					{/each}
				</address>
			{:else}
				<p>{m.admin_order_no_shipping()}</p>
			{/if}
		</div>
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-1 text-(--color-ink)/60">{m.admin_order_session()}</p>
			<p class="font-mono text-xs break-all">{data.order.stripeSessionId}</p>
		</div>
	</aside>
</div>
