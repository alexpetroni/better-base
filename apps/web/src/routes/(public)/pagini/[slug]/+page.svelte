<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();
</script>

<Seo
	title={`${data.page.title} · ${data.site.name}`}
	description={data.page.seoDescription ?? ''}
	canonical={data.canonical}
	siteName={data.site.name}
/>

<article data-testid="simple-page">
	<h1 class="mb-6 text-3xl font-bold">{data.page.title}</h1>
	<div class="prose max-w-none" data-testid="simple-page-body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized server-side by the markdown pipeline -->
		{@html data.page.html}
	</div>
</article>
