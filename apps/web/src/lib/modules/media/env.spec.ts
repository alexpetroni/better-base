import { describe, expect, it } from 'vitest';
import { directOriginFromEnv, imageProviderFromEnv, imageProviderNameFromEnv } from './env.ts';

/**
 * Provider selection from the environment. This is the seam a deploy actually
 * flips (`IMAGE_PROVIDER`), and getting it wrong means every image on every
 * page breaks — so each way it can be wrong gets its own message.
 */

const S3 = { S3_ENDPOINT: 'http://localhost:9000', S3_BUCKET: 'better-base-media' };

describe('imageProviderNameFromEnv', () => {
	// A stock checkout has no IMAGE_PROVIDER, and must still run without a
	// resizer container — that is the whole point of the `direct` default.
	it('defaults to direct when unset or blank', () => {
		expect(imageProviderNameFromEnv({})).toBe('direct');
		expect(imageProviderNameFromEnv({ IMAGE_PROVIDER: '  ' })).toBe('direct');
	});

	it('trims whatever was set', () => {
		expect(imageProviderNameFromEnv({ IMAGE_PROVIDER: ' cloudflare ' })).toBe('cloudflare');
	});

	it('rejects an unknown name instead of silently falling back', () => {
		expect(() => imageProviderNameFromEnv({ IMAGE_PROVIDER: 'imgix' })).toThrow(/imgix/);
		expect(() => imageProviderNameFromEnv({ IMAGE_PROVIDER: 'imgix' })).toThrow(/cloudflare/);
	});
});

describe('directOriginFromEnv', () => {
	// MinIO is path-style, so the bucket is the first path segment. Deriving
	// this is what lets a local checkout work with no extra variable at all.
	it('derives the MinIO bucket URL from the S3 endpoint', () => {
		expect(directOriginFromEnv(S3)).toBe('http://localhost:9000/better-base-media');
	});

	it('tolerates a trailing slash on the endpoint', () => {
		expect(directOriginFromEnv({ ...S3, S3_ENDPOINT: 'http://localhost:9000/' })).toBe(
			'http://localhost:9000/better-base-media'
		);
	});

	it('prefers an explicit MEDIA_PUBLIC_BASE_URL', () => {
		expect(directOriginFromEnv({ ...S3, MEDIA_PUBLIC_BASE_URL: 'https://cdn.test' })).toBe(
			'https://cdn.test'
		);
	});

	it('is empty when neither is derivable', () => {
		expect(directOriginFromEnv({})).toBe('');
	});
});

describe('imageProviderFromEnv', () => {
	it('builds a direct provider from nothing but the S3 vars', () => {
		const provider = imageProviderFromEnv(S3);
		expect(provider.name).toBe('direct');
		expect(provider.transforms).toBe(false);
		expect(provider.url('a/b.png')).toBe('http://localhost:9000/better-base-media/a/b.png');
	});

	it('builds a cloudflare provider and defaults its zone to PUBLIC_SITE_URL', () => {
		const provider = imageProviderFromEnv({
			IMAGE_PROVIDER: 'cloudflare',
			PUBLIC_SITE_URL: 'https://bettersleep.test',
			MEDIA_PUBLIC_BASE_URL: 'https://media.bettersleep.test'
		});
		expect(provider.name).toBe('cloudflare');
		expect(provider.url('a/b.png', { w: 800 })).toBe(
			'https://bettersleep.test/cdn-cgi/image/width=800,fit=scale-down,metadata=none/https://media.bettersleep.test/a/b.png'
		);
	});

	// A media bucket on a different zone than the site is a supported layout,
	// so the transform zone has to be overridable.
	it('lets CF_IMAGE_BASE_URL override the zone', () => {
		const provider = imageProviderFromEnv({
			IMAGE_PROVIDER: 'cloudflare',
			PUBLIC_SITE_URL: 'https://bettersleep.test',
			CF_IMAGE_BASE_URL: 'https://images.bettersleep.test',
			MEDIA_PUBLIC_BASE_URL: 'https://media.bettersleep.test'
		});
		expect(provider.url('a/b.png', { w: 800 })).toContain(
			'https://images.bettersleep.test/cdn-cgi/image/'
		);
	});

	it('names the missing variable when cloudflare is half-configured', () => {
		expect(() =>
			imageProviderFromEnv({ IMAGE_PROVIDER: 'cloudflare', PUBLIC_SITE_URL: 'https://a.test' })
		).toThrow(/MEDIA_PUBLIC_BASE_URL/);
		expect(() =>
			imageProviderFromEnv({
				IMAGE_PROVIDER: 'cloudflare',
				MEDIA_PUBLIC_BASE_URL: 'https://media.test'
			})
		).toThrow(/CF_IMAGE_BASE_URL/);
	});

	it('builds an imgproxy provider from its four variables', () => {
		const provider = imageProviderFromEnv({
			...S3,
			IMAGE_PROVIDER: 'imgproxy',
			IMGPROXY_URL: 'http://localhost:8888',
			IMGPROXY_KEY: 'aa'.repeat(32),
			IMGPROXY_SALT: 'bb'.repeat(32)
		});
		expect(provider.name).toBe('imgproxy');
		expect(provider.transforms).toBe(true);
		expect(provider.url('a/b.png', { w: 300 })).toContain('/rs:fit:300:0/plain/s3://');
	});

	it('names every missing variable when imgproxy is half-configured', () => {
		const err = (() => {
			try {
				imageProviderFromEnv({ IMAGE_PROVIDER: 'imgproxy', IMGPROXY_URL: 'http://x' });
			} catch (e) {
				return e as Error;
			}
		})();
		expect(err?.message).toContain('IMGPROXY_KEY');
		expect(err?.message).toContain('IMGPROXY_SALT');
		expect(err?.message).toContain('S3_BUCKET');
	});
});
