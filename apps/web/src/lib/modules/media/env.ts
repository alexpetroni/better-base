import { createCloudflareProvider, type CloudflareImagesConfig } from './cloudflare.ts';
import { createDirectProvider } from './direct.ts';
import type { ImageProvider, ImageProviderName } from './image.ts';
import { createImgproxyProvider, type ImgproxyConfig } from './imgproxy.ts';
import type { StorageConfig } from './storage.ts';

/**
 * Map env-var names to config objects. Framework-free: `source` is any env
 * record (process.env in scripts/tests, $env/dynamic/private in the app).
 * Missing values map to '' — callers decide whether that is fatal.
 */

export function storageConfigFromEnv(source: Record<string, string | undefined>): StorageConfig {
	return {
		endpoint: source.S3_ENDPOINT ?? '',
		accessKey: source.S3_ACCESS_KEY ?? '',
		secretKey: source.S3_SECRET_KEY ?? '',
		bucket: source.S3_BUCKET ?? '',
		region: source.S3_REGION || 'us-east-1'
	};
}

export function imgproxyConfigFromEnv(source: Record<string, string | undefined>): ImgproxyConfig {
	return {
		baseUrl: source.IMGPROXY_URL ?? '',
		key: source.IMGPROXY_KEY ?? '',
		salt: source.IMGPROXY_SALT ?? '',
		bucket: source.S3_BUCKET ?? ''
	};
}

export function cloudflareConfigFromEnv(
	source: Record<string, string | undefined>
): CloudflareImagesConfig {
	return {
		// The zone that serves /cdn-cgi/image defaults to the site's own origin:
		// on a single-zone deploy they are the same host, and one fewer variable
		// is one fewer way to misconfigure it.
		baseUrl: source.CF_IMAGE_BASE_URL || (source.PUBLIC_SITE_URL ?? ''),
		originBaseUrl: source.MEDIA_PUBLIC_BASE_URL ?? ''
	};
}

export const IMAGE_PROVIDERS = ['cloudflare', 'imgproxy', 'direct'] as const;

export function isImageProviderName(value: string): value is ImageProviderName {
	return (IMAGE_PROVIDERS as readonly string[]).includes(value);
}

/** Which provider `IMAGE_PROVIDER` selects. Defaults to `direct` (dev/tests). */
export function imageProviderNameFromEnv(
	source: Record<string, string | undefined>
): ImageProviderName {
	const raw = source.IMAGE_PROVIDER?.trim();
	if (!raw) return 'direct';
	if (!isImageProviderName(raw)) {
		throw new Error(
			`IMAGE_PROVIDER=${raw} is not one of ${IMAGE_PROVIDERS.join(', ')} — see DEPLOYMENT.md §6`
		);
	}
	return raw;
}

/**
 * Build the provider `IMAGE_PROVIDER` selects. Throws — naming the exact
 * missing variables — when its configuration is incomplete.
 *
 * This IS the requirement list: `boot.ts` and `launch:check` both validate by
 * calling it and catching, so there is no second list of per-provider
 * variables that could drift from what the builder actually reads.
 */
export function imageProviderFromEnv(source: Record<string, string | undefined>): ImageProvider {
	const name = imageProviderNameFromEnv(source);

	if (name === 'imgproxy') {
		const cfg = imgproxyConfigFromEnv(source);
		requireAll(name, {
			IMGPROXY_URL: cfg.baseUrl,
			IMGPROXY_KEY: cfg.key,
			IMGPROXY_SALT: cfg.salt,
			S3_BUCKET: cfg.bucket
		});
		return createImgproxyProvider(cfg);
	}

	if (name === 'cloudflare') {
		const cfg = cloudflareConfigFromEnv(source);
		requireAll(name, {
			MEDIA_PUBLIC_BASE_URL: cfg.originBaseUrl,
			'CF_IMAGE_BASE_URL (or PUBLIC_SITE_URL)': cfg.baseUrl
		});
		return createCloudflareProvider(cfg);
	}

	const originBaseUrl = directOriginFromEnv(source);
	requireAll(name, { 'MEDIA_PUBLIC_BASE_URL (or S3_ENDPOINT + S3_BUCKET)': originBaseUrl });
	return createDirectProvider({ originBaseUrl });
}

/**
 * Where `direct` serves originals from. Explicit `MEDIA_PUBLIC_BASE_URL` wins;
 * otherwise it is derived from the S3 endpoint, which is what makes a stock
 * local checkout work with no extra variable (MinIO is path-style, so the
 * bucket is just the first path segment).
 */
export function directOriginFromEnv(source: Record<string, string | undefined>): string {
	if (source.MEDIA_PUBLIC_BASE_URL) return source.MEDIA_PUBLIC_BASE_URL;
	const endpoint = source.S3_ENDPOINT?.replace(/\/$/, '');
	const bucket = source.S3_BUCKET;
	return endpoint && bucket ? `${endpoint}/${bucket}` : '';
}

function requireAll(provider: ImageProviderName, values: Record<string, string>): void {
	const missing = Object.entries(values)
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length) {
		throw new Error(`IMAGE_PROVIDER=${provider} needs: ${missing.join(', ')}`);
	}
}
