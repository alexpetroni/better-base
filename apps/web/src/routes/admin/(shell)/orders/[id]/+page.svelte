<script lang="ts">
	import { formatDate } from '$lib/util/date';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { formatCents } from '$lib/util/money';
	import { legalTransitions } from '$lib/modules/shop';

	let { data, form } = $props();

	const statusLabels: Record<string, () => string> = {
		pending: m.admin_order_status_pending,
		paid: m.admin_order_status_paid,
		failed: m.admin_order_status_failed,
		refunded: m.admin_order_status_refunded
	};
	const fulfillmentLabels: Record<string, () => string> = {
		unfulfilled: m.admin_order_fulfillment_unfulfilled,
		packed: m.admin_order_fulfillment_packed,
		shipped: m.admin_order_fulfillment_shipped,
		delivered: m.admin_order_fulfillment_delivered,
		returned: m.admin_order_fulfillment_returned,
		cancelled: m.admin_order_fulfillment_cancelled
	};

	const transitions = $derived(legalTransitions(data.order.fulfillmentStatus));

	function eventLabel(event: (typeof data.events)[number]): string {
		if (event.kind === 'created') return m.admin_order_event_created();
		if (event.kind === 'refund-marked') return m.admin_order_event_refund_marked();
		if (event.kind === 'fulfillment-transition' && event.fromStatus && event.toStatus) {
			return m.admin_order_event_fulfillment({
				from: fulfillmentLabels[event.fromStatus](),
				to: fulfillmentLabels[event.toStatus]()
			});
		}
		return event.kind;
	}

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
	<span
		data-testid="order-detail-fulfillment"
		class="rounded bg-(--color-brand-soft)/60 px-2 py-0.5 text-xs font-semibold text-(--color-ink)"
	>
		{fulfillmentLabels[data.order.fulfillmentStatus]()}
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
	<div class="space-y-6">
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

		<div class="rounded-lg border border-(--color-brand-soft) bg-white">
			<h2 class="border-b border-(--color-brand-soft) px-4 py-3 text-sm font-semibold">
				{m.admin_order_history()}
			</h2>
			{#if data.events.length === 0}
				<p class="px-4 py-3 text-sm text-(--color-ink)/70">{m.admin_order_history_empty()}</p>
			{:else}
				<ul class="divide-y divide-(--color-brand-soft)/50 text-sm">
					{#each data.events as event (event.id)}
						<li class="px-4 py-3" data-testid="order-event" data-kind={event.kind}>
							<p class="font-medium">{eventLabel(event)}</p>
							<p class="text-xs text-(--color-ink)/60">
								{formatDate(event.createdAt, 'medium-time')} · {event.actor}
							</p>
							{#if event.note}
								<p class="mt-1 text-(--color-ink)/80" data-testid="order-event-note">
									{event.note}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>

	<aside class="space-y-4 text-sm">
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-2 font-semibold">{m.admin_order_transitions()}</p>
			{#if transitions.length === 0}
				<p class="text-(--color-ink)/70" data-testid="order-transitions-none">
					{m.admin_order_transition_none()}
				</p>
			{:else}
				<form method="POST" action="?/transition" class="space-y-3">
					<label class="block">
						<span class="mb-1 block text-xs text-(--color-ink)/60">
							{m.admin_order_transition_note()}
						</span>
						<textarea
							name="note"
							rows="2"
							class="w-full rounded border border-(--color-brand-soft) px-2 py-1"></textarea>
					</label>
					<div class="flex flex-wrap gap-2">
						{#each transitions as target (target)}
							<button
								type="submit"
								name="to"
								value={target}
								data-testid="order-transition"
								data-to={target}
								class="rounded bg-(--color-brand) px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
							>
								{m.admin_order_transition_mark({ status: fulfillmentLabels[target]() })}
							</button>
						{/each}
					</div>
				</form>
			{/if}
			{#if form?.error}
				<p class="mt-2 text-xs text-red-700" data-testid="order-transition-error">
					{m.admin_order_transition_illegal()}
				</p>
			{/if}
		</div>
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-1 text-(--color-ink)/60">{m.admin_orders_col_date()}</p>
			<p>{formatDate(data.order.createdAt, 'long-time')}</p>
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
