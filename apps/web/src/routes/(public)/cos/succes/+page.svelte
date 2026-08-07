<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { formatCents } from '$lib/util/money';

	let { data } = $props();
</script>

<svelte:head>
	<title>{m.success_heading()} · {data.site.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-xl" data-testid="checkout-success">
	<h1 class="mb-4 text-3xl font-bold">{m.success_heading()}</h1>

	{#if data.state === 'order'}
		<p class="mb-6" data-testid="success-order">
			{m.success_order_intro({ email: data.email })}
		</p>
		<ul
			class="divide-y divide-(--color-brand-soft) rounded-lg border border-(--color-brand-soft) bg-white"
		>
			{#each data.items as item (item.name + item.qty)}
				<li class="flex items-center justify-between gap-4 px-4 py-3" data-testid="success-item">
					<span>{item.name} ×{item.qty}</span>
					<span class="font-semibold">{formatCents(item.lineTotalCents, data.currency)}</span>
				</li>
			{/each}
			<li class="flex items-center justify-between gap-4 px-4 py-3">
				<span class="font-semibold">{m.success_total()}</span>
				<strong data-testid="success-total">{formatCents(data.totalCents, data.currency)}</strong>
			</li>
		</ul>
		{#if data.invoiceDocs.length > 0}
			<div
				class="mt-6 rounded-lg border border-(--color-brand-soft) bg-white p-4"
				data-testid="success-invoice"
			>
				<h2 class="mb-1 font-semibold">{m.success_invoice_heading()}</h2>
				<p class="mb-3 text-sm text-(--color-ink)/70">{m.success_invoice_intro()}</p>
				<ul class="space-y-2">
					{#each data.invoiceDocs as doc (doc.displayNumber)}
						<li class="flex flex-wrap items-center gap-3" data-kind={doc.kind}>
							<span class="font-mono text-sm font-semibold">{doc.displayNumber}</span>
							<a
								href={doc.pdfUrl}
								data-testid="success-invoice-pdf"
								class="text-sm text-(--color-brand) hover:underline"
							>
								{m.success_invoice_pdf()}
							</a>
							<a
								href={doc.xmlUrl}
								data-testid="success-invoice-xml"
								class="text-sm text-(--color-brand) hover:underline"
							>
								{m.success_invoice_xml()}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{:else}
		<p
			class="mb-6 rounded-lg border border-(--color-brand-soft) bg-white p-4"
			data-testid="success-processing"
		>
			{m.success_processing()}
		</p>
		{#if data.totalCents !== null}
			<p class="mb-6">
				{m.success_total()}:
				<strong data-testid="success-total">{formatCents(data.totalCents, data.currency)}</strong>
			</p>
		{/if}
	{/if}

	<p class="mt-8">
		<a href={resolve('/(public)/magazin')} class="text-(--color-brand) hover:underline">
			{m.success_back_shop()}
		</a>
	</p>
</div>
