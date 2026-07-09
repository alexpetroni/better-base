import { createHmac } from 'node:crypto';
import type { MediaRow } from './schema.ts';

/**
 * Pure signed-imgproxy-URL building. No network, no env access — config is
 * passed in, so everything here is unit-testable offline. Server-only (the
 * HMAC key must never reach the client): pages build URLs in `load` and ship
 * plain strings/`ImageSources` to components.
 */

export interface ImgproxyConfig {
	/** Browser-reachable imgproxy origin, e.g. http://localhost:8888 */
	baseUrl: string;
	/** Hex-encoded HMAC key (IMGPROXY_KEY). */
	key: string;
	/** Hex-encoded HMAC salt (IMGPROXY_SALT). */
	salt: string;
	/** Storage bucket imgproxy reads sources from (s3://<bucket>/<key>). */
	bucket: string;
}

export type ImgFit = 'fit' | 'fill' | 'fill-down' | 'crop';
export type ImgFormat = 'webp' | 'avif' | 'jpg' | 'png';

export interface ImgOptions {
	w?: number;
	h?: number;
	fit?: ImgFit;
	format?: ImgFormat;
	dpr?: number;
	/** Serve with `Content-Disposition: attachment` (imgproxy `att:1`) — used for SVGs. */
	attachment?: boolean;
}

/** Sign an imgproxy path (must start with `/`): base64url(HMAC-SHA256(key, salt + path)). */
export function signImgproxyPath(path: string, keyHex: string, saltHex: string): string {
	const hmac = createHmac('sha256', Buffer.from(keyHex, 'hex'));
	hmac.update(Buffer.from(saltHex, 'hex'));
	hmac.update(path);
	return hmac.digest('base64url');
}

/** The unsigned processing path for a storage key, e.g. `/rs:fit:300:0/plain/s3://bucket/key@webp`. */
export function imgproxyPath(
	cfg: Pick<ImgproxyConfig, 'bucket'>,
	key: string,
	opts: ImgOptions = {}
): string {
	const parts: string[] = [];
	if (opts.w !== undefined || opts.h !== undefined) {
		parts.push(`rs:${opts.fit ?? 'fit'}:${opts.w ?? 0}:${opts.h ?? 0}`);
	}
	if (opts.dpr !== undefined && opts.dpr !== 1) parts.push(`dpr:${opts.dpr}`);
	if (opts.attachment) parts.push('att:1');
	const source = `plain/s3://${cfg.bucket}/${key}${opts.format ? `@${opts.format}` : ''}`;
	return `/${[...parts, source].join('/')}`;
}

/** Full signed imgproxy URL for a storage key. */
export function buildImgUrl(cfg: ImgproxyConfig, key: string, opts: ImgOptions = {}): string {
	const path = imgproxyPath(cfg, key, opts);
	return `${cfg.baseUrl.replace(/\/$/, '')}/${signImgproxyPath(path, cfg.key, cfg.salt)}${path}`;
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
 */
export function buildSrcset(
	cfg: ImgproxyConfig,
	key: string,
	opts: Omit<ImgOptions, 'dpr'> & { w: number }
): string {
	return srcsetWidths(opts.w)
		.map((width) => {
			const height = opts.h === undefined ? undefined : Math.round((opts.h * width) / opts.w);
			return `${buildImgUrl(cfg, key, { ...opts, w: width, h: height })} ${width}w`;
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
}

/** Build `ImageSources` for a media row (or bare storage key) at a display width. */
export function imageSources(
	cfg: ImgproxyConfig,
	source: Pick<MediaRow, 'key' | 'width' | 'height' | 'alt'> | string,
	opts: Omit<ImgOptions, 'format' | 'dpr'> & { w: number }
): ImageSources {
	const row = typeof source === 'string' ? null : source;
	const key = row ? row.key : (source as string);
	if (!key) throw new Error('imageSources: media row has no storage key (video embed?)');

	// SVGs are served as-is: rasterizing/resizing them is pointless and imgproxy
	// may not have conversion enabled for them. Because they stay SVG (active
	// content), they are served with `att:1` — a direct navigation downloads
	// instead of rendering in the imgproxy origin (audit M1); imgproxy also
	// strips scripts via IMGPROXY_SANITIZE_SVG (docker-compose.yml).
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

	return {
		src: buildImgUrl(cfg, key, isSvg ? { attachment: true } : { ...size, format: 'webp' }),
		srcsetWebp: isSvg ? '' : buildSrcset(cfg, key, { ...size, format: 'webp' }),
		srcsetAvif: isSvg ? '' : buildSrcset(cfg, key, { ...size, format: 'avif' }),
		width: opts.w,
		height,
		alt: row?.alt ?? ''
	};
}
