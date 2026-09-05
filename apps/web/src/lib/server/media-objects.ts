import type { Storage } from '../modules/media/storage.ts';
import { looksLikeSvg, sanitizeSvg } from '../modules/media/svg.ts';

/**
 * How an image becomes a SERVED object — the one step every path that writes
 * an image into the media bucket goes through: admin upload confirm, content
 * import and the seed (FIX-15). Framework-free (relative imports only) so the
 * seed and content CLIs run it under plain node, and shared here rather than
 * inside the media module because the content module needs it at runtime.
 */

/** Served originals never change under a key, so the origin may cache forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Where the bytes of a served object come from. */
export type MediaObjectSource = { pendingKey: string } | { bytes: Uint8Array };

/**
 * Produce the served object for `key`:
 *   - SVGs: sanitized bytes written fresh, `Content-Disposition: attachment`
 *     so even a sanitizer miss downloads instead of executing on the origin
 *     (audit M1). Returns `'not-svg'` when the bytes are not an SVG document.
 *   - Rasters: server-side copy from the quarantine key (no bytes through the
 *     function) or a direct put, with nothing inherited from the source.
 * Both carry the immutable cache header — the object under a key never
 * changes (a re-upload is a new key), so the origin may cache it forever.
 */
export async function finalizeMediaObject(
	storage: Storage,
	key: string,
	mime: string,
	source: MediaObjectSource
): Promise<'ok' | 'not-svg'> {
	if (mime === 'image/svg+xml') {
		const raw = 'bytes' in source ? source.bytes : await storage.getObjectBytes(source.pendingKey);
		const text = new TextDecoder().decode(raw);
		if (!looksLikeSvg(text)) return 'not-svg';
		await storage.putObject(key, sanitizeSvg(text), mime, {
			cacheControl: IMMUTABLE_CACHE_CONTROL,
			contentDisposition: 'attachment'
		});
		return 'ok';
	}
	if ('bytes' in source) {
		await storage.putObject(key, source.bytes, mime, { cacheControl: IMMUTABLE_CACHE_CONTROL });
	} else {
		await storage.copyObject(source.pendingKey, key, mime, {
			cacheControl: IMMUTABLE_CACHE_CONTROL
		});
	}
	return 'ok';
}
