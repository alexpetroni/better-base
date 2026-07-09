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
	const statusClasses: Record<string, string> = {
		pending: 'bg-(--color-brand-soft) text-(--color-ink)',
		paid: 'bg-green-100 text-green-800',
		failed: 'bg-red-100 text-red-800',
		refunded: 'bg-amber-100 text-amber-800'
	};

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head>
	<title>{m.admin_nav_orders()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_orders()}</h1>

{#if data.orders.length === 0}
	<p data-testid="orders-empty" class="text-(--color-ink)/70">{m.admin_orders_empty()}</p>
{:else}
	<table class="w-full rounded-lg border border-(--color-brand-soft) bg-white text-sm">
		<thead>
			<tr class="border-b border-(--color-brand-soft) text-left text-(--color-ink)/70">
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_date()}</th>
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_email()}</th>
				<th class="px-4 py-2 text-right font-medium">{m.admin_orders_col_total()}</th>
				<th class="px-4 py-2 font-medium">{m.admin_orders_col_status()}</th>
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
							{dateFmt.format(order.createdAt)}
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
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
