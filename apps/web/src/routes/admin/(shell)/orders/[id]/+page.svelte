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

	// `missing-recipient-data` names fields as language-neutral tokens.
	const recipientFieldLabels: Record<string, () => string> = {
		phone: m.admin_order_recipient_phone,
		county: m.admin_order_recipient_county,
		city: m.admin_order_recipient_city,
		line1: m.admin_order_recipient_line1
	};
	function recipientFields(detail: string): string {
		return detail
			.split(', ')
			.filter(Boolean)
			.map((field) => (recipientFieldLabels[field] ?? (() => field))())
			.join(', ');
	}

	// The address editor's fields, in form order; `state` is the county.
	const ADDRESS_FIELDS: Array<{ name: keyof NonNullable<typeof shipping>; label: () => string }> = [
		{ name: 'name', label: m.admin_order_address_name },
		{ name: 'phone', label: m.admin_order_address_phone },
		{ name: 'line1', label: m.admin_order_address_line1 },
		{ name: 'line2', label: m.admin_order_address_line2 },
		{ name: 'city', label: m.admin_order_address_city },
		{ name: 'state', label: m.admin_order_address_state },
		{ name: 'postalCode', label: m.admin_order_address_postal_code },
		{ name: 'country', label: m.admin_order_address_country }
	];

	const shipmentStatusLabels: Record<string, () => string> = {
		creating: m.admin_order_shipment_status_creating,
		failed: m.admin_order_shipment_status_failed,
		registered: m.admin_order_shipment_status_registered,
		'in-transit': m.admin_order_shipment_status_in_transit,
		delivered: m.admin_order_shipment_status_delivered,
		returned: m.admin_order_shipment_status_returned,
		cancelled: m.admin_order_shipment_status_cancelled
	};

	function eventLabel(event: (typeof data.events)[number]): string {
		if (event.kind === 'created') return m.admin_order_event_created();
		if (event.kind === 'refund-marked') return m.admin_order_event_refund_marked();
		if (event.kind === 'refund-partial') return m.admin_order_event_refund_partial();
		if (event.kind === 'payment-succeeded') return m.admin_order_event_payment_succeeded();
		if (event.kind === 'payment-failed') return m.admin_order_event_payment_failed();
		if (event.kind === 'invoice-issued') return m.admin_order_event_invoice_issued();
		if (event.kind === 'invoice-failed') return m.admin_order_event_invoice_failed();
		if (event.kind === 'storno-issued') return m.admin_order_event_storno_issued();
		if (event.kind === 'storno-failed') return m.admin_order_event_storno_failed();
		if (event.kind === 'awb-generated') return m.admin_order_event_awb_generated();
		if (event.kind === 'shipment-status') return m.admin_order_event_shipment_status();
		if (event.kind === 'shipment-cancelled') return m.admin_order_event_shipment_cancelled();
		if (event.kind === 'shipment-cancel-failed')
			return m.admin_order_event_shipment_cancel_failed();
		if (event.kind === 'awb-failed') return m.admin_order_event_awb_failed();
		if (event.kind === 'awb-cancelled-externally')
			return m.admin_order_event_awb_cancelled_externally();
		if (event.kind === 'shipment-sync-error') return m.admin_order_event_shipment_sync_error();
		if (event.kind === 'shipping-address-updated')
			return m.admin_order_event_shipping_address_updated();
		if (event.kind === 'fulfillment-transition' && event.fromStatus && event.toStatus) {
			return m.admin_order_event_fulfillment({
				from: fulfillmentLabels[event.fromStatus](),
				to: fulfillmentLabels[event.toStatus]()
			});
		}
		return event.kind;
	}

	// Fiscal state: the original's gross, what stornos reverse so far, and
	// what a partial storno would reverse now (refunded − already reversed).
	const invoiceGrossCents = $derived(
		data.invoices.find((doc) => doc.kind === 'invoice')?.grossTotalCents ?? null
	);
	const stornoDueCents = $derived(Math.max(0, data.order.refundedCents - data.reversedCents));
	const fiscalIncomplete = $derived(
		invoiceGrossCents === null ||
			(data.order.status === 'refunded' && data.reversedCents < invoiceGrossCents)
	);

	const shipping = $derived(data.order.shippingAddress);
	// A cancelled or failed row (or a stale claim) no longer holds an AWB: the
	// button offers a (re)generation while the order is still shippable.
	const canGenerateAwb = $derived(
		data.order.status === 'paid' &&
			(data.order.fulfillmentStatus === 'unfulfilled' ||
				data.order.fulfillmentStatus === 'packed') &&
			(!data.shipment || ['cancelled', 'failed', 'creating'].includes(data.shipment.status))
	);
	const addressEditorOpen = $derived(
		form?.awbError === 'missing-recipient-data' || !!form?.addressError
	);
	const shippingLines = $derived(
		shipping
			? [
					shipping.name,
					shipping.phone,
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
	{#if data.order.status === 'paid' && data.order.refundedCents > 0}
		<span
			data-testid="order-detail-refund-partial"
			class="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800"
		>
			{m.admin_order_refund_partial()}
		</span>
	{/if}
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
				{#if data.order.refundedCents > 0}
					<li class="flex items-center justify-between gap-4 px-4 py-3 text-amber-800">
						<span>{m.admin_order_refunded_amount()}</span>
						<span class="font-semibold" data-testid="order-detail-refunded">
							−{formatCents(data.order.refundedCents, data.order.currency)}
						</span>
					</li>
				{/if}
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
						{@const parked = data.parkedSubmissions.find((row) => row.invoiceId === doc.id)}
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
							{#if parked}
								<p class="mt-1 text-xs text-red-700" data-testid="order-efactura-parked">
									{m.admin_order_efactura_parked({
										attempts: parked.attempts,
										error: parked.error ?? '—'
									})}
								</p>
								<form method="POST" action="?/requeue" class="mt-1">
									<input type="hidden" name="invoiceId" value={doc.id} />
									<button
										type="submit"
										data-testid="order-efactura-requeue"
										class="rounded bg-(--color-brand-soft) px-3 py-1 text-xs font-semibold hover:opacity-90"
									>
										{m.admin_order_efactura_requeue()}
									</button>
								</form>
							{/if}
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
				{#if form?.requeued}
					<p class="mt-2 text-xs text-green-700" data-testid="order-efactura-requeued">
						{m.admin_order_efactura_requeued()}
					</p>
				{/if}
				{#if form?.requeueError}
					<p class="mt-2 text-xs text-red-700" data-testid="order-efactura-requeue-error">
						{m.admin_order_efactura_requeue_error()}
					</p>
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
			{#if invoiceGrossCents !== null && stornoDueCents > 0}
				<form method="POST" action="?/stornoPartial" class="mt-3">
					<button
						type="submit"
						data-testid="order-storno-partial"
						class="rounded bg-(--color-brand) px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
					>
						{m.admin_order_storno_partial({
							amount: formatCents(stornoDueCents, data.order.currency)
						})}
					</button>
				</form>
			{/if}
			{#if form?.stornoIssued}
				<p class="mt-2 text-xs text-green-700" data-testid="order-storno-partial-issued">
					{m.admin_order_storno_partial_issued()}
				</p>
			{/if}
			{#if form?.stornoError}
				<p class="mt-2 text-xs text-red-700" data-testid="order-storno-partial-error">
					{m.admin_order_storno_partial_error()}
					{form.stornoDetail
						? ` (${form.stornoError}: ${form.stornoDetail})`
						: ` (${form.stornoError})`}
				</p>
			{/if}
			{#if (data.order.status === 'paid' || data.order.status === 'refunded') && fiscalIncomplete}
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
						{data.shipment.awb ?? '—'}
					</p>
					<p class="text-xs text-(--color-ink)/60" data-testid="order-shipment-status">
						{(shipmentStatusLabels[data.shipment.status] ?? (() => data.shipment?.status ?? ''))()}
						· {formatDate(data.shipment.createdAt, 'medium-time')}
					</p>
					{#if data.shipment.lastError}
						<p
							class="mt-1 text-xs break-words text-red-700"
							data-testid="order-shipment-last-error"
						>
							{data.shipment.lastError}
						</p>
					{/if}
					{#if data.shipment.awb}
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
					{/if}
				</div>
			{:else}
				<p class="text-(--color-ink)/70" data-testid="order-shipment-none">
					{m.admin_order_shipment_none()}
				</p>
			{/if}
			{#if canGenerateAwb}
				<form method="POST" action="?/generateAwb" class="mt-3">
					<button
						type="submit"
						data-testid="order-shipment-generate"
						class="rounded bg-(--color-brand) px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
					>
						{data.shipment && data.shipment.status !== 'creating'
							? m.admin_order_shipment_retry()
							: m.admin_order_shipment_generate()}
					</button>
				</form>
			{/if}
			{#if form?.awbError}
				<p class="mt-2 text-xs text-red-700" data-testid="order-shipment-error">
					{form.awbError === 'order-not-paid'
						? m.admin_order_shipment_err_not_paid()
						: form.awbError === 'order-not-shippable'
							? m.admin_order_shipment_err_not_shippable()
							: form.awbError === 'missing-recipient-data'
								? m.admin_order_shipment_err_missing_recipient({
										fields: recipientFields(form.awbDetail ?? '')
									})
								: m.admin_order_shipment_err_courier({ detail: form.awbDetail ?? '' })}
					{#if form.awbError === 'missing-recipient-data'}
						<a href="#shipping-address" class="underline" data-testid="order-shipment-edit-address">
							{m.admin_order_shipment_edit_address()}
						</a>
					{/if}
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
		<div id="shipping-address" class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
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
			<details class="mt-3" open={addressEditorOpen} data-testid="order-address-editor">
				<summary class="cursor-pointer text-xs text-(--color-brand)">
					{m.admin_order_address_edit()}
				</summary>
				<form method="POST" action="?/updateShippingAddress" class="mt-2 space-y-2">
					{#each ADDRESS_FIELDS as field (field.name)}
						<label class="block">
							<span class="mb-1 block text-xs text-(--color-ink)/60">{field.label()}</span>
							<input
								name={field.name}
								value={shipping?.[field.name] ?? (field.name === 'country' ? 'RO' : '')}
								data-testid={`order-address-${field.name}`}
								class="w-full rounded border border-(--color-brand-soft) px-2 py-1"
							/>
						</label>
					{/each}
					<button
						type="submit"
						data-testid="order-address-save"
						class="rounded bg-(--color-brand) px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
					>
						{m.admin_order_address_save()}
					</button>
				</form>
				{#if form?.addressUpdated}
					<p class="mt-2 text-xs text-green-700" data-testid="order-address-saved">
						{m.admin_order_address_saved()}
					</p>
				{/if}
				{#if form?.addressError}
					<p class="mt-2 text-xs text-red-700" data-testid="order-address-error">
						{m.admin_order_shipment_err_missing_recipient({
							fields: recipientFields(form.addressDetail ?? '')
						})}
					</p>
				{/if}
			</details>
		</div>
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<p class="mb-1 text-(--color-ink)/60">{m.admin_order_session()}</p>
			<p class="font-mono text-xs break-all">{data.order.stripeSessionId}</p>
		</div>
	</aside>
</div>
