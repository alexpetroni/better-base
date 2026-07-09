<script lang="ts">
	import { dev } from '$app/environment';
	import type { ImageSources } from './imgproxy.ts';

	interface Props {
		/** Built server-side with `imgSources()` — signing never happens client-side. */
		image: ImageSources;
		/** Overrides the alt stored on the media row. */
		alt?: string;
		/** Explicitly mark a purely decorative image (renders alt=""). */
		decorative?: boolean;
		/**
		 * Rendered size for the width-descriptor srcsets, e.g.
		 * `(min-width: 48rem) 26rem, calc(100vw - 2rem)`. Defaults to the
		 * requested layout width, which matches the old fixed 1x/2x behavior.
		 */
		sizes?: string;
		loading?: 'lazy' | 'eager';
		class?: string;
	}

	let {
		image,
		alt,
		decorative = false,
		sizes,
		loading = 'lazy',
		class: className
	}: Props = $props();

	const resolvedAlt = $derived(decorative ? '' : (alt ?? image.alt));
	const resolvedSizes = $derived(sizes ?? (image.width ? `${image.width}px` : undefined));

	$effect(() => {
		if (dev && !decorative && !resolvedAlt) {
			console.warn('<Img>: empty alt without the `decorative` prop', image.src);
		}
	});
</script>

<picture>
	{#if image.srcsetAvif}
		<source type="image/avif" srcset={image.srcsetAvif} sizes={resolvedSizes} />
	{/if}
	{#if image.srcsetWebp}
		<source type="image/webp" srcset={image.srcsetWebp} sizes={resolvedSizes} />
	{/if}
	<img
		src={image.src}
		alt={resolvedAlt}
		width={image.width}
		height={image.height}
		{loading}
		decoding="async"
		class={className}
	/>
</picture>
