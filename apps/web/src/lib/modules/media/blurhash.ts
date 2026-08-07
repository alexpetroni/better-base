import { decode, encode, isBlurhashValid } from 'blurhash';
import { PNG } from 'pngjs';

/**
 * Pure blurhash encode/decode helpers — no network, no env, unit-testable
 * offline. The pixel source is always a TINY PNG (imgproxy renders the
 * original at ≤32px — see `computeBlurhash` in service.ts), so encoding is
 * cheap enough for a serverless request; the size guard below turns a
 * pipeline bug that feeds a full-size image into a loud error instead of a
 * silent CPU burn.
 */

/** Longest edge of the tiny render blurhashes are encoded from. */
export const BLURHASH_SOURCE_PX = 32;

/** 4×3 components: the blurhash-recommended default for landscape photos. */
export const BLURHASH_X_COMPONENTS = 4;
export const BLURHASH_Y_COMPONENTS = 3;

/** Encode refuses anything bigger than this (64×64×4 covers every ≤32px render). */
const MAX_ENCODE_PIXELS = 64 * 64;

/** Longest edge of the decoded inline placeholder. */
const PLACEHOLDER_PX = 32;

/** Encode a blurhash from the bytes of a (tiny) PNG. Throws on corrupt bytes. */
export function blurhashFromPng(pngBytes: Uint8Array): string {
	const png = PNG.sync.read(Buffer.from(pngBytes));
	if (png.width * png.height > MAX_ENCODE_PIXELS) {
		throw new Error(
			`blurhashFromPng: ${png.width}×${png.height} is not a tiny render (max ${MAX_ENCODE_PIXELS} px)`
		);
	}
	// pngjs always decodes to 8-bit RGBA, exactly what encode() expects.
	const pixels = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
	return encode(pixels, png.width, png.height, BLURHASH_X_COMPONENTS, BLURHASH_Y_COMPONENTS);
}

/**
 * Decode a blurhash into an inline `data:image/png` placeholder at ≤32px,
 * shaped by the natural aspect ratio when known (4:3 otherwise, matching the
 * dimensionless fallback in `imageSources`). Returns null for an invalid
 * hash — a corrupt DB value must never break a page render.
 */
export function blurhashPlaceholder(
	hash: string,
	natural: { w: number; h: number } | null = null
): string | null {
	if (!isBlurhashValid(hash).result) return null;
	const aspect = natural && natural.w > 0 && natural.h > 0 ? natural.h / natural.w : 3 / 4;
	const width = aspect <= 1 ? PLACEHOLDER_PX : Math.max(1, Math.round(PLACEHOLDER_PX / aspect));
	const height = aspect <= 1 ? Math.max(1, Math.round(PLACEHOLDER_PX * aspect)) : PLACEHOLDER_PX;

	const pixels = decode(hash, width, height);
	const png = new PNG({ width, height });
	png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}
