import { createHmac } from 'node:crypto';
import type { ImageProvider, ImgOptions } from './image.ts';

/**
 * Pure signed-imgproxy-URL building. No network, no env access — config is
 * passed in, so everything here is unit-testable offline. Server-only (the
 * HMAC key must never reach the client): pages build URLs in `load` and ship
 * plain strings/`ImageSources` to components.
 *
 * imgproxy is the VPS target's transformer, selected with
 * `IMAGE_PROVIDER=imgproxy`. The Vercel target uses Cloudflare instead
 * (`cloudflare.ts`), which is why nothing here is loaded unless chosen.
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

export function createImgproxyProvider(cfg: ImgproxyConfig): ImageProvider {
	return {
		name: 'imgproxy',
		transforms: true,
		url: (key, opts = {}) => buildImgUrl(cfg, key, opts)
	};
}
