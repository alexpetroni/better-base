import type { ImgproxyConfig } from './imgproxy.ts';
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
