<script lang="ts">
	import { formatDate } from '$lib/util/date';
	import Seo from '$lib/components/Seo.svelte';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';

	let { data } = $props();
</script>

<Seo
	title={data.article.seoTitle || `${data.article.title} · ${data.site.name}`}
	description={data.article.seoDescription || data.article.excerpt}
	canonical={data.canonical}
	siteName={data.site.name}
	ogType="article"
	ogImage={data.ogImage}
	ogImageAlt={data.ogImageAlt}
	jsonLd={data.jsonLd}
/>

<article data-testid="article-page">
	<header class="mb-8">
		<h1 class="mb-2 text-3xl font-bold" data-testid="article-title">{data.article.title}</h1>
		{#if data.article.publishedAt}
			<p class="text-sm text-(--color-ink)/70">
				{m.blog_published_on({ date: formatDate(data.article.publishedAt, 'long') })}
			</p>
		{/if}
		{#if data.cover}
			<Img
				image={data.cover}
				class="mt-6 w-full rounded-lg bg-(--color-brand-soft)/20"
				loading="eager"
			/>
		{/if}
	</header>

	<div class="prose max-w-none" data-testid="article-body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized server-side by the markdown pipeline -->
		{@html data.html}
	</div>
</article>
