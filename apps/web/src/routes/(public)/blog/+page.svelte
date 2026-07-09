<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import Seo from '$lib/components/Seo.svelte';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';

	let { data } = $props();

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'long' });

	// A resolved pathname plus a query string is still a resolved destination.
	function pageHref(page: number): ResolvedPathname {
		return `${resolve('/(public)/blog')}?page=${page}` as ResolvedPathname;
	}
</script>

<Seo
	title={`${m.blog_heading()} · ${data.site.name}`}
	description={m.blog_tagline()}
	canonical={data.canonical}
	siteName={data.site.name}
/>

<h1 class="mb-2 text-3xl font-bold">{m.blog_heading()}</h1>
<p class="mb-8 text-lg text-(--color-ink)/80">{m.blog_tagline()}</p>

{#if data.cards.length === 0}
	<p data-testid="blog-empty" class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
		{m.blog_empty()}
	</p>
{:else}
	<ul class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
		{#each data.cards as card (card.slug)}
			<li
				data-testid="blog-card"
				data-slug={card.slug}
				class="overflow-hidden rounded-lg border border-(--color-brand-soft) bg-white"
			>
				<a href={resolve('/(public)/blog/[slug]', { slug: card.slug })} class="group block">
					{#if card.cover}
						<Img
							image={card.cover}
							class="aspect-[8/5] w-full bg-(--color-brand-soft)/20 object-cover"
						/>
					{:else}
						<div class="aspect-[8/5] w-full bg-(--color-brand-soft)/40"></div>
					{/if}
					<div class="p-4">
						<h2 class="mb-1 font-semibold group-hover:underline">{card.title}</h2>
						{#if card.publishedAt}
							<p class="mb-2 text-xs text-(--color-ink)/60">
								{m.blog_published_on({ date: dateFmt.format(card.publishedAt) })}
							</p>
						{/if}
						{#if card.excerpt}
							<p class="text-sm text-(--color-ink)/80">{card.excerpt}</p>
						{/if}
					</div>
				</a>
			</li>
		{/each}
	</ul>

	{#if data.pageCount > 1}
		<nav data-testid="blog-pagination" class="mt-8 flex items-center justify-center gap-4">
			{#if data.page > 1}
				<a href={pageHref(data.page - 1)} class="text-(--color-brand) hover:underline">
					← {m.blog_page_prev()}
				</a>
			{/if}
			<span class="text-sm text-(--color-ink)/70">
				{m.blog_page_of({ page: data.page, pageCount: data.pageCount })}
			</span>
			{#if data.page < data.pageCount}
				<a href={pageHref(data.page + 1)} class="text-(--color-brand) hover:underline">
					{m.blog_page_next()} →
				</a>
			{/if}
		</nav>
	{/if}
{/if}
