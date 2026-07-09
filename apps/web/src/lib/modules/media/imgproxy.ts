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

/** `imgUrl(key, opts)` bound to a config — the shape services and loads use. */
export function createImgUrl(cfg: ImgproxyConfig) {
	return (key: string, opts: ImgOptions = {}) => buildImgUrl(cfg, key, opts);
}

/** 1x/2x srcset for one format, e.g. `https://…/… 1x, https://…/… 2x`. */
export function buildSrcset(cfg: ImgproxyConfig, key: string, opts: ImgOptions = {}): string {
	return [1, 2].map((dpr) => `${buildImgUrl(cfg, key, { ...opts, dpr })} ${dpr}x`).join(', ');
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
	const size: ImgOptions = isSvg ? {} : { w: opts.w, h: opts.h, fit: opts.fit };

	const natural = row?.width && row?.height ? { w: row.width, h: row.height } : null;
	const height = opts.h ?? (natural ? Math.round((opts.w * natural.h) / natural.w) : undefined);

	return {
		src: buildImgUrl(cfg, key, isSvg ? { attachment: true } : { ...size, format: 'webp' }),
		srcsetWebp: isSvg ? '' : buildSrcset(cfg, key, { ...size, format: 'webp' }),
		srcsetAvif: isSvg ? '' : buildSrcset(cfg, key, { ...size, format: 'avif' }),
		width: opts.w,
		height,
		alt: row?.alt ?? ''
	};
}
