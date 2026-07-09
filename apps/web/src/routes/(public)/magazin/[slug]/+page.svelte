<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import { singleSubmit } from '$lib/components/single-submit';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';
	import { formatCents } from '$lib/util/money';

	let { data } = $props();
</script>

<Seo
	title={`${data.product.name} · ${data.site.name}`}
	description={m.shop_tagline()}
	canonical={data.canonical}
	siteName={data.site.name}
/>

<article data-testid="product-page" class="grid gap-8 md:grid-cols-2">
	<div>
		{#if data.cover}
			<Img
				image={data.cover}
				sizes="(min-width: 48rem) 26rem, calc(100vw - 2rem)"
				class="w-full rounded-lg bg-(--color-brand-soft)/20"
				loading="eager"
			/>
		{:else}
			<div class="aspect-[4/3] w-full rounded-lg bg-(--color-brand-soft)/40"></div>
		{/if}
		{#if data.gallery.length > 0}
			<ul data-testid="product-gallery" class="mt-4 grid grid-cols-3 gap-3">
				{#each data.gallery as image, i (image.src)}
					<li>
						<Img
							{image}
							alt={image.alt || `${data.product.name} ${i + 1}`}
							sizes="(min-width: 48rem) 8rem, calc((100vw - 3.5rem) / 3)"
							class="aspect-square w-full rounded bg-(--color-brand-soft)/20 object-cover"
						/>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div>
		<h1 class="mb-2 text-3xl font-bold" data-testid="product-title">{data.product.name}</h1>
		<p data-testid="product-price" class="mb-6 text-2xl font-semibold text-(--color-brand)">
			{formatCents(data.product.priceCents, data.product.currency)}
		</p>

		<form method="POST" action="?/add" use:singleSubmit class="mb-8 flex items-end gap-3">
			<label class="block text-sm">
				<span class="mb-1 block text-(--color-ink)/70">{m.shop_qty_label()}</span>
				<input
					type="number"
					name="qty"
					value="1"
					min="1"
					max="99"
					data-testid="product-qty"
					disabled={data.product.outOfStock}
					class="w-20 rounded border border-(--color-brand-soft) px-3 py-2"
				/>
			</label>
			<button
				type="submit"
				data-testid="product-add-to-cart"
				disabled={data.product.outOfStock}
				class="rounded bg-(--color-brand) px-5 py-2 font-semibold text-white hover:opacity-90
					disabled:cursor-not-allowed disabled:opacity-40"
			>
				{data.product.outOfStock ? m.shop_out_of_stock() : m.shop_add_to_cart()}
			</button>
		</form>

		{#if data.descriptionHtml}
			<div class="prose max-w-none" data-testid="product-description">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized server-side by the markdown pipeline -->
				{@html data.descriptionHtml}
			</div>
		{/if}
	</div>
</article>
