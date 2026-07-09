import { describe, expect, it } from 'vitest';
import {
	buildImgUrl,
	buildSrcset,
	imageSources,
	imgproxyPath,
	signImgproxyPath,
	type ImgproxyConfig
} from './imgproxy.ts';

// The dev key/salt from docker-compose.yml. The expected signature below was
// verified against the running imgproxy container (curl → 200), so this is a
// live-validated test vector, not a self-referential HMAC re-computation.
const KEY = 'bfd9adf6c395743b3c86b59c5ba7c418986de2ce4f2d6828812a8bf02ae838fb';
const SALT = '04efffdcb59e1b8953506cfd05e0f30de80767ef4c5710ecf514f49a6352fec5';
const CFG: ImgproxyConfig = {
	baseUrl: 'http://imgproxy.test:8888',
	key: KEY,
	salt: SALT,
	bucket: 'better-base-media'
};

describe('signImgproxyPath', () => {
	const path = '/rs:fit:100:100/plain/s3://better-base-media/hand-test/test-image.png@webp';

	it('produces the signature imgproxy accepts for a known key/salt/path', () => {
		expect(signImgproxyPath(path, KEY, SALT)).toBe('ef3ZJfmZCpQsN844cbQfuuTixBOBDc9sejICs6x2Azs');
	});

	it('changes completely when the path is tampered with', () => {
		const tampered = path.replace('100:100', '200:200');
		expect(signImgproxyPath(tampered, KEY, SALT)).not.toBe(signImgproxyPath(path, KEY, SALT));
	});

	it('depends on both key and salt', () => {
		const otherKey = KEY.replace(/^b/, 'a');
		const otherSalt = SALT.replace(/^0/, '1');
		const sig = signImgproxyPath(path, KEY, SALT);
		expect(signImgproxyPath(path, otherKey, SALT)).not.toBe(sig);
		expect(signImgproxyPath(path, KEY, otherSalt)).not.toBe(sig);
	});
});

describe('imgproxyPath', () => {
	it('is a bare plain source without options', () => {
		expect(imgproxyPath(CFG, 'a/b.png')).toBe('/plain/s3://better-base-media/a/b.png');
	});

	it('includes resize, dpr and format when requested', () => {
		expect(
			imgproxyPath(CFG, 'a/b.png', { w: 300, h: 200, fit: 'fill', format: 'avif', dpr: 2 })
		).toBe('/rs:fill:300:200/dpr:2/plain/s3://better-base-media/a/b.png@avif');
	});

	it('defaults fit to "fit" and open dimensions to 0, omits dpr:1', () => {
		expect(imgproxyPath(CFG, 'a/b.png', { w: 300, dpr: 1 })).toBe(
			'/rs:fit:300:0/plain/s3://better-base-media/a/b.png'
		);
	});
});

describe('buildImgUrl', () => {
	it('joins base URL, signature and path', () => {
		const url = buildImgUrl(CFG, 'hand-test/test-image.png', { w: 100, h: 100, format: 'webp' });
		expect(url).toBe(
			'http://imgproxy.test:8888/ef3ZJfmZCpQsN844cbQfuuTixBOBDc9sejICs6x2Azs/rs:fit:100:100/plain/s3://better-base-media/hand-test/test-image.png@webp'
		);
	});

	it('tolerates a trailing slash on the base URL', () => {
		const cfg = { ...CFG, baseUrl: 'http://imgproxy.test:8888/' };
		expect(buildImgUrl(cfg, 'a.png')).not.toContain('8888//');
	});
});

describe('buildSrcset', () => {
	it('emits 1x and 2x candidates', () => {
		const srcset = buildSrcset(CFG, 'a/b.png', { w: 300, format: 'webp' });
		const parts = srcset.split(', ');
		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatch(/\/rs:fit:300:0\/plain\/s3:\/\/better-base-media\/a\/b\.png@webp 1x$/);
		expect(parts[1]).toContain('/dpr:2/');
		expect(parts[1]).toMatch(/ 2x$/);
	});
});

describe('imageSources', () => {
	const row = { key: 'a/photo.jpg', width: 1600, height: 900, alt: 'O poză' };

	it('derives display height from the natural aspect ratio', () => {
		const sources = imageSources(CFG, row, { w: 320 });
		expect(sources.width).toBe(320);
		expect(sources.height).toBe(180);
		expect(sources.alt).toBe('O poză');
		expect(sources.srcsetWebp).toContain('@webp');
		expect(sources.srcsetAvif).toContain('@avif');
	});

	it('accepts a bare storage key', () => {
		const sources = imageSources(CFG, 'x/y.png', { w: 100 });
		expect(sources.src).toContain('s3://better-base-media/x/y.png@webp');
		expect(sources.height).toBeUndefined();
		expect(sources.alt).toBe('');
	});

	it('serves SVGs unresized and without format conversion', () => {
		const sources = imageSources(CFG, { ...row, key: 'a/logo.svg' }, { w: 320 });
		expect(sources.src).toContain('/plain/s3://better-base-media/a/logo.svg');
		expect(sources.src).not.toContain('@webp');
		expect(sources.srcsetWebp).toBe('');
		expect(sources.srcsetAvif).toBe('');
	});

	it('serves SVGs as attachments (audit M1: never rendered on direct navigation)', () => {
		const svg = imageSources(CFG, { ...row, key: 'a/logo.svg' }, { w: 320 });
		expect(svg.src).toContain('/att:1/');
		// Raster formats stay inline-viewable.
		const png = imageSources(CFG, row, { w: 320 });
		expect(png.src).not.toContain('att:1');
	});

	it('throws for a row without a storage key', () => {
		expect(() =>
			imageSources(CFG, { key: null, width: null, height: null, alt: '' }, { w: 100 })
		).toThrow(/no storage key/);
	});
});
