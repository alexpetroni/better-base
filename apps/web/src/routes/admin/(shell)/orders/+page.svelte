<script lang="ts">
	import { formatDate } from '$lib/util/date';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { formatCents } from '$lib/util/money';
	import { FULFILLMENT_STATUSES } from '$lib/modules/shop';

	let { data } = $props();

	const statusLabels: Record<string, () => string> = {
		pending: m.admin_order_status_pending,
		paid: m.admin_order_status_paid,
		failed: m.admin_order_status_failed,
		refunded: m.admin_order_status_refunded
	};
	const statusClasses: Record<string, string> = {
		pending: 'bg-(--color-brand-soft) text-(--color-ink)',
		paid: 'bg-green-100 text-green-800',
		failed: 'bg-red-100 text-red-800',
		refunded: 'bg-amber-100 text-amber-800'
	};
	const fulfillmentLabels: Record<string, () => string> = {
		unfulfilled: m.admin_order_fulfillment_unfulfilled,
		packed: m.admin_order_fulfillment_packed,
		shipped: m.admin_order_fulfillment_shipped,
		delivered: m.admin_order_fulfillment_delivered,
		returned: m.admin_order_fulfillment_returned,
		cancelled: m.admin_order_fulfillment_cancelled
	};

	const filters = $derived([
		{ id: 'action', label: m.admin_orders_filter_action() },
		{ id: 'oversold', label: m.admin_orders_filter_oversold() },
		{ id: 'invoice-missing', label: m.admin_orders_filter_invoice_missing() },
		{ id: 'all', label: m.admin_orders_filter_all() },
		...FULFILLMENT_STATUSES.map((status) => ({ id: status, label: fulfillmentLabels[status]() }))
	]);

	/** Fiscal record incomplete: no invoice, or refunded without its storno. */
	function invoiceMissing(order: (typeof data.orders)[number]): boolean {
		if (order.status === 'paid') return !order.invoiceNumber;
		if (order.status === 'refunded') return !order.invoiceNumber || !order.stornoNumber;
		return false;
	}
</script>

<svelte:head>
	<title>{m.admin_nav_orders()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_orders()}</h1>

<nav class="mb-4 flex flex-wrap gap-2" aria-label={m.admin_orders_col_status()}>
	{#each filters as filter (filter.id)}
		<a
			href="{resolve('/admin/orders')}?f={filter.id}"
			data-testid="orders-filter"
			data-filter={filter.id}
			aria-current={data.filter === filter.id ? 'page' : undefined}
			class="rounded-full border px-3 py-1 text-xs font-semibold
				{data.filter === filter.id
				? 'border-(--color-brand) bg-(--color-brand) text-white'
				: 'border-(--color-brand-soft) bg-white text-(--color-ink) hover:bg-(--color-brand-soft)/30'}"
		>
			{filter.label}
		</a>
	{/each}
</nav>

{#if data.orders.length === 0}
	<p data-testid="orders-empty" class="text-(--color-ink)/70">
		{data.filter === 'all' ? m.admin_orders_empty() : m.admin_orders_empty_filtered()}
	</p>
{:else}
	<table class="w-full rounded-lg border border-(--color-brand-soft) bg-white text-sm">
		<thead>
			<tr class="border-b border-(--color-brand-soft) text-left text-(--color-ink)/70">
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_date()}</th>
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_email()}</th>
				<th class="px-4 py-2 text-right font-medium">{m.admin_orders_col_total()}</th>
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_status()}</th>
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_fulfillment()}</th>
			</tr>
		</thead>
		<tbody>
			{#each data.orders as order (order.id)}
				<tr
					data-testid="order-row"
					data-session={order.stripeSessionId}
					class="border-b border-(--color-brand-soft)/50 last:border-0 hover:bg-(--color-brand-soft)/20"
				>
					<td class="px-4 py-2">
						<a
							href={resolve('/admin/(shell)/orders/[id]', { id: order.id })}
							class="text-(--color-brand) hover:underline"
						>
							{formatDate(order.createdAt, 'medium-time')}
						</a>
					</td>
					<td class="px-4 py-2" data-testid="order-row-email">{order.email}</td>
					<td class="px-4 py-2 text-right font-semibold" data-testid="order-row-total">
						{formatCents(order.amountTotalCents, order.currency)}
					</td>
					<td class="px-4 py-2">
						<span
							data-testid="order-row-status"
							class="rounded px-2 py-0.5 text-xs font-semibold {statusClasses[order.status]}"
						>
							{statusLabels[order.status]()}
						</span>
						{#if order.oversold}
							<span
								data-testid="order-row-oversold"
								class="ml-1 rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
							>
								{m.admin_order_oversold()}
							</span>
						{/if}
						{#if invoiceMissing(order)}
							<span
								data-testid="order-row-no-invoice"
								class="ml-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800"
							>
								{m.admin_order_invoice_missing_badge()}
							</span>
						{/if}
					</td>
					<td class="px-4 py-2">
						<span
							data-testid="order-row-fulfillment"
							class="rounded bg-(--color-brand-soft)/60 px-2 py-0.5 text-xs font-semibold text-(--color-ink)"
						>
							{fulfillmentLabels[order.fulfillmentStatus]()}
						</span>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
