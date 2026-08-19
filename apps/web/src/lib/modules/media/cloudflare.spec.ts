import { describe, expect, it } from 'vitest';
import {
	buildCloudflareImageUrl,
	cloudflareOptions,
	cloudflareOriginUrl,
	createCloudflareProvider,
	type CloudflareImagesConfig
} from './cloudflare.ts';

/**
 * Pure string building, so this runs with no Cloudflare account, no zone and
 * no domain — which is exactly why the provider was written this way.
 */

const CFG: CloudflareImagesConfig = {
	baseUrl: 'https://bettersleep.test',
	originBaseUrl: 'https://media.bettersleep.test'
};

describe('cloudflareOptions', () => {
	it('emits width, height, fit, dpr and format in a fixed order', () => {
		expect(cloudflareOptions({ w: 300, h: 200, fit: 'fill', format: 'avif', dpr: 2 })).toBe(
			'width=300,height=200,fit=cover,dpr=2,format=avif,metadata=none'
		);
	});

	// A reordered option list is a different edge-cache entry AND a different
	// billed transformation, so the order is part of the contract, not cosmetic.
	it('is stable regardless of the key order it was given', () => {
		expect(cloudflareOptions({ format: 'webp', h: 200, fit: 'fill', w: 300 })).toBe(
			cloudflareOptions({ w: 300, fit: 'fill', h: 200, format: 'webp' })
		);
	});

	it('maps our resize modes onto Cloudflare fit values', () => {
		expect(cloudflareOptions({ w: 10 })).toContain('fit=scale-down');
		expect(cloudflareOptions({ w: 10, fit: 'fit' })).toContain('fit=scale-down');
		expect(cloudflareOptions({ w: 10, fit: 'fill' })).toContain('fit=cover');
		expect(cloudflareOptions({ w: 10, fit: 'fill-down' })).toContain('fit=cover');
		expect(cloudflareOptions({ w: 10, fit: 'crop' })).toContain('fit=crop');
	});

	it('spells jpg as jpeg, the name Cloudflare accepts', () => {
		expect(cloudflareOptions({ format: 'jpg' })).toContain('format=jpeg');
		expect(cloudflareOptions({ format: 'png' })).toContain('format=png');
	});

	// imgproxy uses 0 for "no constraint on this axis"; Cloudflare has no such
	// spelling, so the option is simply left out.
	it('omits zero dimensions, and the fit that would have described them', () => {
		expect(cloudflareOptions({ w: 300, h: 0 })).toBe('width=300,fit=scale-down,metadata=none');
		expect(cloudflareOptions({})).toBe('metadata=none');
	});

	it('omits dpr=1 (the default) but keeps a real dpr', () => {
		expect(cloudflareOptions({ w: 10, dpr: 1 })).not.toContain('dpr');
		expect(cloudflareOptions({ w: 10, dpr: 3 })).toContain('dpr=3');
	});

	// Uploaded phone photos carry GPS coordinates in EXIF; derivatives must not.
	it('always strips metadata', () => {
		expect(cloudflareOptions({})).toContain('metadata=none');
		expect(cloudflareOptions({ w: 800, format: 'webp' })).toContain('metadata=none');
	});
});

describe('buildCloudflareImageUrl', () => {
	it('is zone + /cdn-cgi/image + options + the absolute source URL', () => {
		expect(buildCloudflareImageUrl(CFG, 'uploads/2026/08/a-1234abcd.jpg', { w: 800 })).toBe(
			'https://bettersleep.test/cdn-cgi/image/width=800,fit=scale-down,metadata=none/https://media.bettersleep.test/uploads/2026/08/a-1234abcd.jpg'
		);
	});

	it('tolerates trailing slashes on either base URL', () => {
		const url = buildCloudflareImageUrl(
			{ baseUrl: 'https://bettersleep.test/', originBaseUrl: 'https://media.bettersleep.test/' },
			'a.png',
			{ w: 100 }
		);
		expect(url).not.toContain('test//cdn-cgi');
		expect(url).not.toContain('test//a.png');
	});
});

describe('createCloudflareProvider', () => {
	const provider = createCloudflareProvider(CFG);

	it('declares itself as a transforming provider', () => {
		expect(provider.name).toBe('cloudflare');
		expect(provider.transforms).toBe(true);
	});

	// audit M1: an SVG kept as an SVG is active content. Routing it through
	// /cdn-cgi/image would drop the Content-Disposition the object carries and
	// burn a billed transformation for nothing.
	it('bypasses the transformer entirely for attachments (SVGs)', () => {
		expect(provider.url('a/logo.svg', { attachment: true, w: 320 })).toBe(
			cloudflareOriginUrl(CFG, 'a/logo.svg')
		);
		expect(provider.url('a/logo.svg', { attachment: true })).not.toContain('cdn-cgi');
	});

	it('transforms everything else', () => {
		expect(provider.url('a/b.png', { w: 320 })).toBe(
			buildCloudflareImageUrl(CFG, 'a/b.png', { w: 320 })
		);
	});
});
