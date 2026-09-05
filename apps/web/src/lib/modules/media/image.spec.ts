import { describe, expect, it } from 'vitest';
import { createCloudflareProvider } from './cloudflare.ts';
import { createDirectProvider } from './direct.ts';
import { buildSrcset, imageSources, srcsetWidths, type ImageProvider } from './image.ts';
import { createImgproxyProvider } from './imgproxy.ts';

/**
 * The provider-agnostic layer. Every assertion here must hold for whichever
 * provider a deploy selects — the two things that legitimately differ are
 * whether srcsets exist at all (`transforms`) and the exact URL shape, which
 * each provider's own spec pins.
 */

const IMGPROXY = createImgproxyProvider({
	baseUrl: 'http://imgproxy.test:8888',
	key: 'bfd9adf6c395743b3c86b59c5ba7c418986de2ce4f2d6828812a8bf02ae838fb',
	salt: '04efffdcb59e1b8953506cfd05e0f30de80767ef4c5710ecf514f49a6352fec5',
	bucket: 'better-base-media'
});

const CLOUDFLARE = createCloudflareProvider({
	baseUrl: 'https://example.test',
	originBaseUrl: 'https://media.example.test'
});

const DIRECT = createDirectProvider({
	originBaseUrl: 'http://localhost:9000/better-base-media'
});

const TRANSFORMING: [string, ImageProvider][] = [
	['imgproxy', IMGPROXY],
	['cloudflare', CLOUDFLARE]
];

const ALL: [string, ImageProvider][] = [...TRANSFORMING, ['direct', DIRECT]];

describe('srcsetWidths', () => {
	it('spans layout width to 2× (retina) plus ladder steps in between', () => {
		expect(srcsetWidths(768)).toEqual([480, 640, 768, 960, 1200, 1536]);
	});

	it('always includes the layout width and its double, deduped and sorted', () => {
		expect(srcsetWidths(320)).toEqual([320, 480, 640]);
		expect(srcsetWidths(160)).toEqual([160, 320]);
	});
});

describe('buildSrcset', () => {
	// Regression (audit frontend #5): the old srcset was DPR-only (`1x, 2x`),
	// which made the `sizes` attribute dead and over-fetched ~2× on retina.
	it.each(TRANSFORMING)('emits width descriptors, not DPR descriptors (%s)', (_name, provider) => {
		const srcset = buildSrcset(provider, 'a/b.png', { w: 480, format: 'webp' });
		const parts = srcset.split(', ');
		expect(parts.length).toBeGreaterThan(2);
		for (const part of parts) expect(part).toMatch(/ \d+w$/);
		expect(srcset).not.toMatch(/ \dx\b/);
		expect(parts[0]).toMatch(/ 320w$/);
		expect(parts.at(-1)).toMatch(/ 960w$/);
	});

	it.each(TRANSFORMING)(
		'scales a fixed height proportionally per candidate, keeping the aspect (%s)',
		(_name, provider) => {
			const srcset = buildSrcset(provider, 'a/b.png', { w: 480, h: 360, fit: 'fill' });
			// 480×360, 640×480 and 960×720 are all 4:3 — whatever the URL syntax.
			for (const [w, h] of [
				[480, 360],
				[640, 480],
				[960, 720]
			]) {
				expect(srcset).toContain(provider.url('a/b.png', { w, h, fit: 'fill' }));
			}
		}
	);

	// A non-transforming provider has exactly one URL per key. Emitting it N
	// times with different width descriptors would lie to the browser, which
	// would then pick the "widest" — the same original, fetched at full size.
	it('is empty for a non-transforming provider', () => {
		expect(buildSrcset(DIRECT, 'a/b.png', { w: 480, format: 'webp' })).toBe('');
	});
});

describe('imageSources', () => {
	const row = { key: 'a/photo.jpg', width: 1600, height: 900, alt: 'O poză' };

	it.each(ALL)('derives display height from the natural aspect ratio (%s)', (_n, provider) => {
		const sources = imageSources(provider, row, { w: 320 });
		expect(sources.width).toBe(320);
		expect(sources.height).toBe(180);
		expect(sources.alt).toBe('O poză');
	});

	it.each(TRANSFORMING)('offers both modern formats (%s)', (_n, provider) => {
		const sources = imageSources(provider, row, { w: 320 });
		expect(sources.srcsetWebp).toContain(provider.url(row.key, { w: 320, format: 'webp' }));
		expect(sources.srcsetAvif).toContain(provider.url(row.key, { w: 320, format: 'avif' }));
	});

	it.each(ALL)(
		'accepts a bare storage key and falls back to a 4:3 placeholder height (%s)',
		(_n, provider) => {
			const sources = imageSources(provider, 'x/y.png', { w: 100 });
			expect(sources.src).toContain('x/y.png');
			// Regression (audit frontend #14): dimensionless media used to ship no
			// height at all, so the <img> reserved zero space and shifted layout.
			expect(sources.height).toBe(75);
			expect(sources.alt).toBe('');
		}
	);

	it.each(ALL)('gives dimensionless SVGs a placeholder height too (%s)', (_n, provider) => {
		const sources = imageSources(
			provider,
			{ key: 'a/logo.svg', width: null, height: null, alt: 'Logo' },
			{ w: 320 }
		);
		expect(sources.width).toBe(320);
		expect(sources.height).toBe(240);
	});

	it.each(ALL)('serves SVGs unresized and without format conversion (%s)', (_n, provider) => {
		const sources = imageSources(provider, { ...row, key: 'a/logo.svg' }, { w: 320 });
		expect(sources.srcsetWebp).toBe('');
		expect(sources.srcsetAvif).toBe('');
		expect(sources.src).not.toContain('webp');
	});

	// FIX-15 (audit P2): the admin library decoded a blurhash PNG per row per
	// editor load; thumbnails can opt out of the placeholder.
	it.each(ALL)('decodes the blurhash placeholder unless told not to (%s)', (_n, provider) => {
		const withHash = { ...row, blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' };
		expect(imageSources(provider, withHash, { w: 240 }).placeholder).toMatch(/^data:image\/png/);
		expect(imageSources(provider, withHash, { w: 240, placeholder: false }).placeholder).toBeNull();
	});

	it.each(ALL)('throws for a row without a storage key (%s)', (_n, provider) => {
		expect(() =>
			imageSources(provider, { key: null, width: null, height: null, alt: '' }, { w: 100 })
		).toThrow(/no storage key/);
	});

	// The originals path: `direct` cannot resize, so `src` must be the stored
	// object itself — no invented width in the URL, and no srcsets promising
	// sizes that do not exist.
	it('serves the untouched original under a non-transforming provider', () => {
		const sources = imageSources(DIRECT, row, { w: 320 });
		expect(sources.src).toBe('http://localhost:9000/better-base-media/a/photo.jpg');
		expect(sources.srcsetWebp).toBe('');
		expect(sources.srcsetAvif).toBe('');
		// Layout dimensions are still honest, so there is no CLS in dev either.
		expect(sources.width).toBe(320);
		expect(sources.height).toBe(180);
	});

	// audit M1: an SVG must never be RENDERED by a direct navigation. imgproxy
	// can say so per URL; the origin-serving providers rely on the header
	// stored on the object at confirm time, so all they must do is not route
	// the SVG through a transformer that would drop it.
	it('serves SVGs as imgproxy attachments, and as bare origin URLs elsewhere', () => {
		expect(imageSources(IMGPROXY, { ...row, key: 'a/logo.svg' }, { w: 320 }).src).toContain(
			'/att:1/'
		);
		expect(imageSources(IMGPROXY, row, { w: 320 }).src).not.toContain('att:1');

		expect(imageSources(CLOUDFLARE, { ...row, key: 'a/logo.svg' }, { w: 320 }).src).toBe(
			'https://media.example.test/a/logo.svg'
		);
		expect(imageSources(DIRECT, { ...row, key: 'a/logo.svg' }, { w: 320 }).src).toBe(
			'http://localhost:9000/better-base-media/a/logo.svg'
		);
	});
});
