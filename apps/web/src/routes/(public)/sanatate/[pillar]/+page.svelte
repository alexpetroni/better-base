<script lang="ts">
	import { resolve } from '$app/paths';
	import Seo from '$lib/components/Seo.svelte';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';

	let { data } = $props();

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'long' });
</script>

<Seo
	title={`${data.pillar.name} · ${data.site.name}`}
	description={data.pillar.description}
	canonical={data.canonical}
	siteName={data.site.name}
/>

<h1 class="mb-2 text-3xl font-bold" data-testid="pillar-title">{data.pillar.name}</h1>
<p class="mb-8 text-lg">{data.pillar.description}</p>

<section>
	<div class="mb-4 flex items-baseline justify-between">
		<h2 class="text-xl font-semibold">{m.pillar_articles_heading()}</h2>
		<a href={resolve('/(public)/blog')} class="text-sm text-(--color-brand) hover:underline">
			{m.pillar_articles_all()} →
		</a>
	</div>

	{#if data.articles.length === 0}
		<p
			data-testid="pillar-articles-empty"
			class="rounded-lg border border-(--color-brand-soft) bg-white p-4 text-sm"
		>
			{m.blog_empty()}
		</p>
	{:else}
		<ul class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.articles as card (card.slug)}
				<li
					data-testid="pillar-article-card"
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
							<h3 class="mb-1 font-semibold group-hover:underline">{card.title}</h3>
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
	{/if}
</section>
