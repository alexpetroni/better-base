<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';
	import { formatCents } from '$lib/modules/shop';

	let { data, form } = $props();

	const hasUnavailable = $derived(data.lines.some((l) => !l.available));
</script>

<svelte:head>
	<title>{m.cart_heading()} · {data.site.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1 class="mb-6 text-3xl font-bold">{m.cart_heading()}</h1>

{#if data.lines.length === 0}
	<p data-testid="cart-empty" class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
		{m.cart_empty()}
		<a href={resolve('/(public)/magazin')} class="ml-2 text-(--color-brand) hover:underline">
			{m.cart_browse_shop()} →
		</a>
	</p>
{:else}
	<ul
		class="divide-y divide-(--color-brand-soft) rounded-lg border border-(--color-brand-soft) bg-white"
	>
		{#each data.lines as line (line.productId)}
			<li
				data-testid="cart-line"
				data-slug={line.slug}
				class="flex flex-wrap items-center gap-4 p-4 {line.available ? '' : 'opacity-70'}"
			>
				{#if line.cover}
					<Img
						image={line.cover}
						class="h-16 w-20 rounded bg-(--color-brand-soft)/20 object-cover"
					/>
				{:else}
					<div class="h-16 w-20 rounded bg-(--color-brand-soft)/40"></div>
				{/if}
				<div class="min-w-0 grow">
					<a
						href={resolve('/(public)/magazin/[slug]', { slug: line.slug })}
						class="block truncate font-semibold hover:underline"
					>
						{line.name}
					</a>
					<span class="text-sm text-(--color-ink)/70">
						{formatCents(line.priceCents, line.currency)}
					</span>
					{#if !line.available}
						<span data-testid="cart-line-unavailable" class="block text-sm text-red-700">
							{m.cart_unavailable()}
						</span>
					{/if}
				</div>
				<form method="POST" action="?/setQty" class="flex items-center gap-2">
					<input type="hidden" name="productId" value={line.productId} />
					<input
						type="number"
						name="qty"
						value={line.qty}
						min="0"
						max="99"
						aria-label={m.cart_qty_label({ name: line.name })}
						data-testid="cart-qty"
						class="w-18 rounded border border-(--color-brand-soft) px-2 py-1"
					/>
					<button
						type="submit"
						data-testid="cart-qty-update"
						class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:bg-(--color-brand-soft)/70"
					>
						{m.cart_update()}
					</button>
				</form>
				<span data-testid="cart-line-total" class="w-24 text-right font-semibold">
					{formatCents(line.lineTotalCents, line.currency)}
				</span>
				<form method="POST" action="?/remove">
					<input type="hidden" name="productId" value={line.productId} />
					<button
						type="submit"
						data-testid="cart-remove"
						class="text-sm text-red-700 hover:underline"
					>
						{m.cart_remove()}
					</button>
				</form>
			</li>
		{/each}
	</ul>

	<div class="mt-6 flex flex-wrap items-center justify-end gap-4">
		<span class="text-lg">
			{m.cart_total()}:
			<strong data-testid="cart-total">{formatCents(data.totalCents, data.currency)}</strong>
		</span>
		<form method="POST" action="?/checkout">
			<button
				type="submit"
				data-testid="cart-checkout"
				disabled={hasUnavailable}
				class="rounded bg-(--color-brand) px-6 py-2 font-semibold text-white hover:opacity-90
					disabled:cursor-not-allowed disabled:opacity-40"
			>
				{m.cart_checkout()}
			</button>
		</form>
	</div>
	<p class="mt-2 text-right text-sm text-(--color-ink)/60">{m.cart_checkout_note()}</p>

	{#if form?.checkoutError}
		<p data-testid="cart-checkout-error" class="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
			{#if form.checkoutError === 'empty-cart'}
				{m.cart_err_empty()}
			{:else if form.checkoutError === 'unavailable'}
				{m.cart_err_unavailable({ names: form.detail })}
			{:else}
				{m.cart_err_gateway()}
			{/if}
		</p>
	{/if}
{/if}
