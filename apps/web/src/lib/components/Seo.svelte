<script lang="ts">
	import { jsonLdString } from '$lib/seo';

	let {
		title,
		description,
		canonical,
		siteName,
		ogType = 'website',
		ogImage = null,
		ogImageAlt = '',
		jsonLd = null
	}: {
		title: string;
		description: string;
		canonical: string;
		siteName: string;
		ogType?: 'website' | 'article';
		ogImage?: string | null;
		ogImageAlt?: string;
		jsonLd?: Record<string, unknown> | null;
	} = $props();

	// Assembled in pieces: literal script tags inside the string would open or
	// terminate this component's own script block during parsing.
	const openTag = '<' + 'script type="application/ld+json">';
	const closeTag = '</' + 'script>';
	const jsonLdTag = $derived(jsonLd ? `${openTag}${jsonLdString(jsonLd)}${closeTag}` : null);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />

	<meta property="og:type" content={ogType} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta property="og:site_name" content={siteName} />
	{#if ogImage}
		<meta property="og:image" content={ogImage} />
		{#if ogImageAlt}
			<meta property="og:image:alt" content={ogImageAlt} />
		{/if}
	{/if}

	<meta name="twitter:card" content={ogImage ? 'summary_large_image' : 'summary'} />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	{#if ogImage}
		<meta name="twitter:image" content={ogImage} />
	{/if}

	{#if jsonLdTag}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- serialized with < escaped, see jsonLdString -->
		{@html jsonLdTag}
	{/if}
</svelte:head>
