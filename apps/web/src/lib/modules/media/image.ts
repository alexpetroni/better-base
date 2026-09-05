import { blurhashPlaceholder } from './blurhash.ts';
import type { MediaRow } from './schema.ts';

/**
 * Provider-agnostic image URL building.
 *
 * Every page renders images through `ImageSources`, and that contract must not
 * depend on WHO resizes the bytes. Three providers implement `ImageProvider`:
 *
 *   - `cloudflare` — Cloudflare Image Transformations (`/cdn-cgi/image/…`) in
 *     front of the public R2 origin. The production default: no always-on box,
 *     so a Vercel deploy needs nothing but Vercel + Neon + Cloudflare.
 *   - `imgproxy`   — the signed self-hosted transformer (VPS target).
 *   - `direct`     — originals served as-is, no transforms. Local dev and the
 *     test suite, so neither needs a resizer container.
 *
 * Pure: no network, no env access — config is passed in, so everything here is
 * unit-testable offline. Providers that sign URLs are server-only (their key
 * must never reach the client), so pages build sources in `load` and ship
 * plain strings to components.
 */

export type ImageProviderName = 'cloudflare' | 'imgproxy' | 'direct';

export type ImgFit = 'fit' | 'fill' | 'fill-down' | 'crop';
export type ImgFormat = 'webp' | 'avif' | 'jpg' | 'png';

export interface ImgOptions {
	w?: number;
	h?: number;
	fit?: ImgFit;
	format?: ImgFormat;
	dpr?: number;
	/**
	 * Ask for `Content-Disposition: attachment` — used for SVGs, which stay
	 * active content. Only imgproxy can apply it per-URL (`att:1`); the other
	 * providers serve originals straight from storage, where the header is set
	 * on the OBJECT at upload time instead (`finalizeMediaObject`).
	 */
	attachment?: boolean;
}

export interface ImageProvider {
	readonly name: ImageProviderName;
	/**
	 * False when the provider hands back the stored original untouched. Callers
	 * that need a derivative (srcsets, the tiny blurhash render) must check this
	 * instead of assuming every provider can resize.
	 */
	readonly transforms: boolean;
	/** URL for one derivative of a storage key. */
	url(key: string, opts?: ImgOptions): string;
}

/** Candidate-width ladder for width-descriptor srcsets. */
const SRCSET_LADDER = [320, 480, 640, 768, 960, 1200, 1600] as const;

/**
 * Candidate widths for a layout width `w`: ladder entries between w/2 and 2×w,
 * plus w and 2×w themselves (2× covers retina). Sorted ascending, deduped.
 */
export function srcsetWidths(displayWidth: number): number[] {
	const min = Math.ceil(displayWidth / 2);
	const max = displayWidth * 2;
	const ladder = SRCSET_LADDER.filter((width) => width >= min && width <= max);
	return [...new Set([...ladder, displayWidth, max])].sort((a, b) => a - b);
}

/**
 * Width-descriptor srcset, e.g. `https://… 480w, https://… 768w, https://… 1536w`
 * — lets the browser pick per viewport×DPR via the `sizes` attribute instead
 * of always fetching 2× on retina (audit frontend #5). A fixed `h` (fill
 * crops) scales proportionally per candidate so the aspect never changes.
 *
 * Empty for a non-transforming provider: one original cannot honestly claim
 * several widths, and a srcset of identical URLs would make the browser
 * download the biggest one for nothing.
 */
export function buildSrcset(
	provider: ImageProvider,
	key: string,
	opts: Omit<ImgOptions, 'dpr'> & { w: number }
): string {
	if (!provider.transforms) return '';
	return srcsetWidths(opts.w)
		.map((width) => {
			const height = opts.h === undefined ? undefined : Math.round((opts.h * width) / opts.w);
			return `${provider.url(key, { ...opts, w: width, h: height })} ${width}w`;
		})
		.join(', ');
}

/**
 * Everything the <Img> component needs, as a plain serializable object built
 * server-side (URL signing cannot happen on the client).
 */
export interface ImageSources {
	src: string;
	srcsetWebp: string;
	srcsetAvif: string;
	/** Rendered dimensions (the requested resize box, aspect-corrected when known). */
	width: number | undefined;
	height: number | undefined;
	alt: string;
	/**
	 * Tiny inline PNG decoded from the row's blurhash, shown behind the real
	 * image while it loads. Null when the row has no (valid) blurhash — the
	 * component then behaves exactly as before.
	 */
	placeholder: string | null;
}

export type ImageSourceInput =
	(Pick<MediaRow, 'key' | 'width' | 'height' | 'alt'> & { blurhash?: string | null }) | string;

/** Build `ImageSources` for a media row (or bare storage key) at a display width. */
export function imageSources(
	provider: ImageProvider,
	source: ImageSourceInput,
	// `placeholder: false` skips the blurhash decode (a PNG per call) —
	// thumbnail grids that render dozens of rows per load opt out (FIX-15).
	opts: Omit<ImgOptions, 'format' | 'dpr'> & { w: number; placeholder?: boolean }
): ImageSources {
	const row = typeof source === 'string' ? null : source;
	const key = row ? row.key : (source as string);
	if (!key) throw new Error('imageSources: media row has no storage key (video embed?)');

	// SVGs are served as-is: rasterizing/resizing them is pointless, and they
	// stay active content, so they are served with `Content-Disposition:
	// attachment` — a direct navigation downloads instead of rendering on the
	// media origin (audit M1). imgproxy applies that per URL (`att:1`) and also
	// strips scripts via IMGPROXY_SANITIZE_SVG; under the origin-serving
	// providers the header lives on the stored object (set at confirm time).
	const isSvg = key.endsWith('.svg');
	const size = { w: opts.w, h: opts.h, fit: opts.fit };

	const natural = row?.width && row?.height ? { w: row.width, h: row.height } : null;
	// Dimensionless media (e.g. an SVG without width/viewBox) still gets a
	// height so the <img> reserves layout space (no CLS): a 4:3 placeholder box
	// matching the cover crops used across the site. Tailwind's preflight sets
	// `img { height: auto }`, so the real intrinsic ratio takes over on load.
	const height =
		opts.h ??
		(natural ? Math.round((opts.w * natural.h) / natural.w) : Math.round((opts.w * 3) / 4));

	const original = isSvg || !provider.transforms;

	return {
		src: original
			? provider.url(key, isSvg ? { attachment: true } : {})
			: provider.url(key, { ...size, format: 'webp' }),
		srcsetWebp: original ? '' : buildSrcset(provider, key, { ...size, format: 'webp' }),
		srcsetAvif: original ? '' : buildSrcset(provider, key, { ...size, format: 'avif' }),
		width: opts.w,
		height,
		alt: row?.alt ?? '',
		placeholder:
			opts.placeholder !== false && !isSvg && row?.blurhash
				? blurhashPlaceholder(row.blurhash, natural)
				: null
	};
}
