import type { ImageProvider, ImgFit, ImgFormat, ImgOptions } from './image.ts';

/**
 * Cloudflare Image Transformations: `https://<zone>/cdn-cgi/image/<options>/<source>`.
 *
 * The zone rewrites the request at the edge, fetches the source itself and
 * caches the derivative — so the production deploy needs no always-on
 * transformer box (this is what lets the Vercel target drop imgproxy-on-Fly).
 *
 * There is no URL signature. Cloudflare only transforms sources it is allowed
 * to fetch, and we point it at our own R2 public origin, so the exposure is
 * "anyone who knows a storage key can request arbitrary sizes of it" rather
 * than imgproxy's "anyone can transform anything". Keep the media hostname on
 * the same zone (or listed under the zone's allowed origins) so a third party
 * cannot use the endpoint as an open image proxy — see DEPLOYMENT.md §6.
 *
 * Pure and offline: no network, no env, no secret. Everything here is a string
 * builder, which is why it is fully testable without a Cloudflare account or a
 * domain.
 */

export interface CloudflareImagesConfig {
	/**
	 * Origin whose zone serves `/cdn-cgi/image` — normally the site itself,
	 * e.g. `https://bettersleep.ro`. Trailing slash optional.
	 */
	baseUrl: string;
	/**
	 * Public origin serving the stored originals (the R2 bucket's custom
	 * domain), e.g. `https://media.bettersleep.ro`. Trailing slash optional.
	 */
	originBaseUrl: string;
}

/**
 * imgproxy's resize modes mapped onto Cloudflare's `fit`:
 *   fit       → scale-down (shrink into the box, never enlarge) — imgproxy's
 *               default `rs:fit` behaviour without `enlarge`
 *   fill      → cover      (fill the box, crop the overflow)
 *   fill-down → cover
 *   crop      → crop
 * The mapping is deliberately lossy in one place: Cloudflare's `cover` will
 * enlarge a source smaller than the box, where imgproxy's `fill-down` will not.
 * Our sources are ≥ the layout widths we ask for, so it never bites in practice.
 */
const FIT: Record<ImgFit, string> = {
	fit: 'scale-down',
	fill: 'cover',
	'fill-down': 'cover',
	crop: 'crop'
};

/** Cloudflare spells JPEG out; the others match our names. */
const FORMAT: Record<ImgFormat, string> = {
	webp: 'webp',
	avif: 'avif',
	jpg: 'jpeg',
	png: 'png'
};

/**
 * The comma-separated option list, in a fixed order so URLs are stable (a
 * reordered option list is a different cache entry AND a different billed
 * transformation). `width=0` is imgproxy's "open dimension" and is simply
 * omitted here. `metadata=none` strips EXIF — camera GPS must not ride along
 * with an uploaded photo.
 */
export function cloudflareOptions(opts: ImgOptions = {}): string {
	const parts: string[] = [];
	if (opts.w) parts.push(`width=${opts.w}`);
	if (opts.h) parts.push(`height=${opts.h}`);
	if (opts.w || opts.h) parts.push(`fit=${FIT[opts.fit ?? 'fit']}`);
	if (opts.dpr !== undefined && opts.dpr !== 1) parts.push(`dpr=${opts.dpr}`);
	if (opts.format) parts.push(`format=${FORMAT[opts.format]}`);
	parts.push('metadata=none');
	return parts.join(',');
}

function trim(url: string): string {
	return url.replace(/\/$/, '');
}

/** Public URL of the untouched original for a storage key. */
export function cloudflareOriginUrl(cfg: CloudflareImagesConfig, key: string): string {
	return `${trim(cfg.originBaseUrl)}/${key}`;
}

/** Full `/cdn-cgi/image/…` URL for a storage key. */
export function buildCloudflareImageUrl(
	cfg: CloudflareImagesConfig,
	key: string,
	opts: ImgOptions = {}
): string {
	return `${trim(cfg.baseUrl)}/cdn-cgi/image/${cloudflareOptions(opts)}/${cloudflareOriginUrl(cfg, key)}`;
}

export function createCloudflareProvider(cfg: CloudflareImagesConfig): ImageProvider {
	return {
		name: 'cloudflare',
		transforms: true,
		url(key, opts = {}) {
			// An SVG is never transformed (`attachment` is our SVG marker): it is
			// served straight from the origin, where the object itself carries
			// `Content-Disposition: attachment`. Routing it through /cdn-cgi/image
			// would either rasterize it or pass it through while burning a billed
			// transformation, and would drop the header either way.
			if (opts.attachment) return cloudflareOriginUrl(cfg, key);
			return buildCloudflareImageUrl(cfg, key, opts);
		}
	};
}
