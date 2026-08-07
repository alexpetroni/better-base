import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { blurhashFromPng, blurhashPlaceholder } from './blurhash.ts';

// Deterministic in-memory fixture: a 32×24 horizontal sky-to-amber gradient.
// Rebuilt per call, so equality across calls proves the whole pipeline
// (PNG decode → blurhash encode) is deterministic, not just memoized.
function gradientPng(width = 32, height = 24): Uint8Array {
	const png = new PNG({ width, height });
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			png.data[i] = Math.round((x / (width - 1)) * 255);
			png.data[i + 1] = 96;
			png.data[i + 2] = Math.round((y / (height - 1)) * 255);
			png.data[i + 3] = 255;
		}
	}
	return PNG.sync.write(png);
}

describe('blurhashFromPng', () => {
	it('is deterministic for the same image', () => {
		const first = blurhashFromPng(gradientPng());
		expect(first).toBe(blurhashFromPng(gradientPng()));
		// 4×3 components → 6-char header+DC plus 11×2 chars of AC coefficients.
		expect(first).toHaveLength(6 + 11 * 2);
	});

	it('changes when the image changes', () => {
		expect(blurhashFromPng(gradientPng())).not.toBe(blurhashFromPng(gradientPng(24, 32)));
	});

	it('throws on corrupt bytes instead of returning garbage', () => {
		expect(() => blurhashFromPng(new Uint8Array([1, 2, 3, 4]))).toThrow();
	});

	it('refuses a full-size image (the pipeline must feed tiny renders)', () => {
		expect(() => blurhashFromPng(gradientPng(128, 128))).toThrow(/tiny render/);
	});
});

describe('blurhashPlaceholder', () => {
	const hash = blurhashFromPng(gradientPng());

	function decodeDataUri(uri: string): PNG {
		expect(uri).toMatch(/^data:image\/png;base64,/);
		return PNG.sync.read(Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64'));
	}

	it('decodes to a ≤32px PNG shaped by the natural aspect ratio', () => {
		const landscape = decodeDataUri(blurhashPlaceholder(hash, { w: 1600, h: 900 })!);
		expect({ w: landscape.width, h: landscape.height }).toEqual({ w: 32, h: 18 });

		const portrait = decodeDataUri(blurhashPlaceholder(hash, { w: 900, h: 1600 })!);
		expect({ w: portrait.width, h: portrait.height }).toEqual({ w: 18, h: 32 });
	});

	it('falls back to 4:3 when the row has no dimensions', () => {
		const fallback = decodeDataUri(blurhashPlaceholder(hash)!);
		expect({ w: fallback.width, h: fallback.height }).toEqual({ w: 32, h: 24 });
	});

	it('returns null for an invalid hash — a corrupt DB value must not break renders', () => {
		expect(blurhashPlaceholder('not-a-blurhash', { w: 100, h: 100 })).toBeNull();
		expect(blurhashPlaceholder('', { w: 100, h: 100 })).toBeNull();
	});
});
