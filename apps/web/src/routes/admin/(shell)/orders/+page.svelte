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
		{ id: 'efactura-pending', label: m.admin_orders_filter_efactura_pending() },
		{ id: 'all', label: m.admin_orders_filter_all() },
		...FULFILLMENT_STATUSES.map((status) => ({ id: status, label: fulfillmentLabels[status]() }))
	]);

	// Default the accountant export to the current month (cosmetic only —
	// the operator picks the month; the server validates it).
	const defaultExportMonth = new Date().toISOString().slice(0, 7);
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

<form
	method="GET"
	action="{resolve('/admin/orders')}/export"
	class="mb-4 flex flex-wrap items-center gap-2 text-sm"
	data-testid="orders-export"
>
	<label class="text-(--color-ink)/70" for="orders-export-month">
		{m.admin_orders_export_label()}
	</label>
	<input
		id="orders-export-month"
		type="month"
		name="month"
		value={defaultExportMonth}
		required
		class="rounded border border-(--color-brand-soft) px-2 py-1"
	/>
	<button
		type="submit"
		class="rounded border border-(--color-brand) px-3 py-1 text-xs font-semibold text-(--color-brand) hover:bg-(--color-brand-soft)/40"
	>
		{m.admin_orders_export_button()}
	</button>
</form>

{#if data.unmatchedRefunds.length > 0 || data.emptyCartEvents.length > 0}
	<section
		data-testid="orders-attention"
		class="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
	>
		<p class="mb-1 font-semibold">{m.admin_orders_attention()}</p>
		<ul class="space-y-1">
			{#each data.unmatchedRefunds as refund (refund.paymentIntent)}
				<li data-testid="orders-attention-refund" data-intent={refund.paymentIntent}>
					{m.admin_orders_attention_refund({
						intent: refund.paymentIntent,
						amount: formatCents(refund.amountRefundedCents),
						total: formatCents(refund.amountCents),
						date: formatDate(refund.receivedAt, 'medium-time')
					})}
				</li>
			{/each}
			{#each data.emptyCartEvents as event (event.eventId)}
				<li data-testid="orders-attention-empty-cart" data-event={event.eventId}>
					{m.admin_orders_attention_empty_cart({
						eventId: event.eventId,
						date: formatDate(event.receivedAt, 'medium-time')
					})}
				</li>
			{/each}
		</ul>
	</section>
{/if}

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
						{#if order.status === 'paid' && order.refundedCents > 0}
							<span
								data-testid="order-row-refund-partial"
								class="ml-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800"
							>
								{m.admin_order_refund_partial()}
							</span>
						{/if}
						{#if order.fiscalIncomplete}
							<span
								data-testid="order-row-no-invoice"
								class="ml-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800"
							>
								{m.admin_order_invoice_missing_badge()}
							</span>
						{/if}
						{#if order.efacturaDaysLeft !== null}
							<span
								data-testid="order-row-efactura"
								data-days-left={order.efacturaDaysLeft}
								class="ml-1 rounded px-2 py-0.5 text-xs font-semibold {order.efacturaDaysLeft < 0
									? 'bg-red-100 text-red-800'
									: 'bg-amber-100 text-amber-800'}"
							>
								{order.efacturaDaysLeft < 0
									? m.admin_order_efactura_overdue({ days: -order.efacturaDaysLeft })
									: m.admin_order_efactura_due({ days: order.efacturaDaysLeft })}
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
