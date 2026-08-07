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

	const shipmentStatusLabels: Record<string, () => string> = {
		registered: m.admin_order_shipment_status_registered,
		'in-transit': m.admin_order_shipment_status_in_transit,
		delivered: m.admin_order_shipment_status_delivered,
		returned: m.admin_order_shipment_status_returned,
		cancelled: m.admin_order_shipment_status_cancelled
	};

	function eventLabel(event: (typeof data.events)[number]): string {
		if (event.kind === 'created') return m.admin_order_event_created();
		if (event.kind === 'refund-marked') return m.admin_order_event_refund_marked();
		if (event.kind === 'invoice-issued') return m.admin_order_event_invoice_issued();
		if (event.kind === 'invoice-failed') return m.admin_order_event_invoice_failed();
		if (event.kind === 'storno-issued') return m.admin_order_event_storno_issued();
		if (event.kind === 'storno-failed') return m.admin_order_event_storno_failed();
		if (event.kind === 'awb-generated') return m.admin_order_event_awb_generated();
		if (event.kind === 'shipment-status') return m.admin_order_event_shipment_status();
		if (event.kind === 'shipment-cancelled') return m.admin_order_event_shipment_cancelled();
		if (event.kind === 'shipment-cancel-failed')
			return m.admin_order_event_shipment_cancel_failed();
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
				{#if data.order.shippingCents > 0}
					<li class="flex items-center justify-between gap-4 px-4 py-3">
						<span>
							{m.admin_order_shipping_cost()}
							{#if data.order.shippingName}
								<span class="text-(--color-ink)/60">— {data.order.shippingName}</span>
							{/if}
						</span>
						<span class="font-semibold" data-testid="order-detail-shipping-cost">
							{formatCents(data.order.shippingCents, data.order.currency)}
						</span>
					</li>
				{/if}
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
			<p class="mb-2 font-semibold">{m.admin_order_invoice()}</p>
			{#if data.invoices.length === 0}
				<p class="text-(--color-ink)/70" data-testid="order-invoice-none">
					{m.admin_order_invoice_none()}
				</p>
			{:else}
				<ul class="space-y-2">
					{#each data.invoices as doc (doc.id)}
						<li data-testid="order-invoice" data-kind={doc.kind}>
							<p class="font-mono font-semibold">{doc.displayNumber}</p>
							<p class="text-xs text-(--color-ink)/60">
								{doc.kind === 'storno'
									? m.admin_order_invoice_kind_storno()
									: m.admin_order_invoice_kind_invoice()}
								· {formatDate(doc.issuedAt, 'medium-time')}
								· {formatCents(doc.grossTotalCents, doc.currency)}
							</p>
							<p class="mt-1 flex gap-3 text-xs">
								<a
									href={resolve('/api/invoices/[id]/[format]', { id: doc.id, format: 'pdf' })}
									data-testid="order-invoice-pdf"
									class="text-(--color-brand) hover:underline"
								>
									{m.admin_order_invoice_pdf()}
								</a>
								<a
									href={resolve('/api/invoices/[id]/[format]', { id: doc.id, format: 'xml' })}
									data-testid="order-invoice-xml"
									class="text-(--color-brand) hover:underline"
								>
									{m.admin_order_invoice_xml()}
								</a>
							</p>
						</li>
					{/each}
				</ul>
				{#if data.order.email}
					<form method="POST" action="?/resendInvoice" class="mt-3">
						<input type="hidden" name="nonce" value={data.resendNonce} />
						<button
							type="submit"
							data-testid="order-invoice-resend"
							class="rounded border border-(--color-brand) px-3 py-1.5 text-xs font-semibold text-(--color-brand) hover:bg-(--color-brand-soft)/40"
						>
							{m.admin_order_invoice_resend()}
						</button>
					</form>
				{/if}
				{#if form?.invoiceResent}
					<p class="mt-2 text-xs text-green-700" data-testid="order-invoice-resent">
						{form.resendSkipped
							? m.admin_order_invoice_resend_skipped()
							: m.admin_order_invoice_resent()}
					</p>
				{/if}
				{#if form?.resendError}
					<p class="mt-2 text-xs text-red-700" data-testid="order-invoice-resend-error">
						{m.admin_order_invoice_resend_error()}
					</p>
				{/if}
			{/if}
			{#if (data.order.status === 'paid' || data.order.status === 'refunded') && (data.invoices.length === 0 || (data.order.status === 'refunded' && !data.invoices.some((d) => d.kind === 'storno')))}
				<form method="POST" action="?/issueInvoice" class="mt-3">
					<button
						type="submit"
						data-testid="order-invoice-issue"
						class="rounded bg-(--color-brand) px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
					>
						{m.admin_order_invoice_issue()}
					</button>
				</form>
			{/if}
			{#if form?.invoiceError}
				<p class="mt-2 text-xs text-red-700" data-testid="order-invoice-error">
					{m.admin_order_invoice_error()}
					{form.invoiceDetail ? ` (${form.invoiceDetail})` : ''}
				</p>
			{/if}
		</div>
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-2 font-semibold">{m.admin_order_shipment()}</p>
			{#if data.shipment}
				<div data-testid="order-shipment" data-status={data.shipment.status}>
					<p class="font-mono font-semibold" data-testid="order-shipment-awb">
						{data.shipment.awb}
					</p>
					<p class="text-xs text-(--color-ink)/60" data-testid="order-shipment-status">
						{(shipmentStatusLabels[data.shipment.status] ?? (() => data.shipment?.status ?? ''))()}
						· {formatDate(data.shipment.createdAt, 'medium-time')}
					</p>
					<p class="mt-1 flex gap-3 text-xs">
						<a
							href={data.shipment.trackingUrl}
							target="_blank"
							rel="noopener"
							data-testid="order-shipment-tracking"
							class="text-(--color-brand) hover:underline"
						>
							{m.admin_order_shipment_tracking()}
						</a>
						<a
							href={resolve('/api/shipments/[id]/label', { id: data.shipment.id })}
							data-testid="order-shipment-label"
							class="text-(--color-brand) hover:underline"
						>
							{m.admin_order_shipment_label()}
						</a>
					</p>
				</div>
			{:else}
				<p class="text-(--color-ink)/70" data-testid="order-shipment-none">
					{m.admin_order_shipment_none()}
				</p>
				{#if data.order.status === 'paid' && (data.order.fulfillmentStatus === 'unfulfilled' || data.order.fulfillmentStatus === 'packed')}
					<form method="POST" action="?/generateAwb" class="mt-3">
						<button
							type="submit"
							data-testid="order-shipment-generate"
							class="rounded bg-(--color-brand) px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
						>
							{m.admin_order_shipment_generate()}
						</button>
					</form>
				{/if}
			{/if}
			{#if form?.awbError}
				<p class="mt-2 text-xs text-red-700" data-testid="order-shipment-error">
					{form.awbError === 'order-not-paid'
						? m.admin_order_shipment_err_not_paid()
						: form.awbError === 'order-not-shippable'
							? m.admin_order_shipment_err_not_shippable()
							: m.admin_order_shipment_err_courier({ detail: form.awbDetail ?? '' })}
				</p>
			{/if}
		</div>
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-1 text-(--color-ink)/60">{m.admin_orders_col_date()}</p>
			<p>{formatDate(data.order.createdAt, 'long-time')}</p>
			<p class="mt-3 mb-1 text-(--color-ink)/60">{m.admin_orders_col_email()}</p>
			<p data-testid="order-detail-email">{data.order.email}</p>
			{#if data.order.billingCompany}
				<p class="mt-3 mb-1 text-(--color-ink)/60">{m.admin_order_company()}</p>
				<p data-testid="order-detail-company">
					{[
						data.order.billingCompany.name,
						data.order.billingCompany.cui,
						data.order.billingCompany.regCom
					]
						.filter(Boolean)
						.join(' · ')}
				</p>
			{/if}
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
