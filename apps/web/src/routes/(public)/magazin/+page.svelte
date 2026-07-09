<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import Seo from '$lib/components/Seo.svelte';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';
	import { formatCents } from '$lib/util/money';

	let { data } = $props();

	// A resolved pathname plus a query string is still a resolved destination.
	function filterHref(slug: string | null): ResolvedPathname {
		const base = resolve('/(public)/magazin');
		return (slug ? `${base}?pilon=${slug}` : base) as ResolvedPathname;
	}
</script>

<Seo
	title={`${m.shop_heading()} · ${data.site.name}`}
	description={m.shop_tagline()}
	canonical={data.canonical}
	siteName={data.site.name}
/>

<h1 class="mb-2 text-3xl font-bold">{m.shop_heading()}</h1>
<p class="mb-8 text-lg text-(--color-ink)/80">{m.shop_tagline()}</p>

{#if data.pillarFilters.length > 0}
	<nav data-testid="shop-pillar-filter" class="mb-6 flex flex-wrap gap-1">
		<a
			href={filterHref(null)}
			class="rounded px-3 py-1 text-sm {data.activeFilter === null
				? 'bg-(--color-brand) font-semibold text-white'
				: 'bg-(--color-brand-soft)/50 hover:bg-(--color-brand-soft)'}"
		>
			{m.shop_filter_all()}
		</a>
		{#each data.pillarFilters as pillar (pillar.slug)}
			<a
				href={filterHref(pillar.slug)}
				class="rounded px-3 py-1 text-sm {data.activeFilter === pillar.slug
					? 'bg-(--color-brand) font-semibold text-white'
					: 'bg-(--color-brand-soft)/50 hover:bg-(--color-brand-soft)'}"
			>
				{pillar.name}
			</a>
		{/each}
	</nav>
{/if}

{#if data.cards.length === 0}
	<p data-testid="shop-empty" class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
		{m.shop_empty()}
	</p>
{:else}
	<ul class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
		{#each data.cards as card (card.slug)}
			<li
				data-testid="product-card"
				data-slug={card.slug}
				class="overflow-hidden rounded-lg border border-(--color-brand-soft) bg-white"
			>
				<a href={resolve('/(public)/magazin/[slug]', { slug: card.slug })} class="group block">
					{#if card.cover}
						<Img
							image={card.cover}
							class="aspect-[4/3] w-full bg-(--color-brand-soft)/20 object-cover"
						/>
					{:else}
						<div class="aspect-[4/3] w-full bg-(--color-brand-soft)/40"></div>
					{/if}
					<div class="p-4">
						<h2 class="mb-1 font-semibold group-hover:underline">{card.name}</h2>
						<p class="flex items-center gap-2">
							<span data-testid="product-price" class="font-semibold text-(--color-brand)">
								{formatCents(card.priceCents, card.currency)}
							</span>
							{#if card.outOfStock}
								<span
									data-testid="product-out-of-stock"
									class="rounded bg-(--color-brand-soft) px-2 py-0.5 text-xs"
								>
									{m.shop_out_of_stock()}
								</span>
							{/if}
						</p>
					</div>
				</a>
			</li>
		{/each}
	</ul>
{/if}
