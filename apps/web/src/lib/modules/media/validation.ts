/**
 * Pure upload validation and storage-key generation — no I/O, unit-testable.
 */

/** Accepted upload mime types and the extension their stored key gets. */
export const ALLOWED_IMAGE_MIMES = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/gif': 'gif',
	'image/svg+xml': 'svg'
} as const;

export type AllowedImageMime = keyof typeof ALLOWED_IMAGE_MIMES;

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type UploadValidation =
	{ ok: true; mime: AllowedImageMime; ext: string } | { ok: false; reason: 'mime' | 'size' };

export function isAllowedImageMime(mime: string): mime is AllowedImageMime {
	return mime in ALLOWED_IMAGE_MIMES;
}

/** Validate a prospective upload's declared mime and byte size. */
export function validateUpload(input: { mime: string; size: number }): UploadValidation {
	if (!isAllowedImageMime(input.mime)) return { ok: false, reason: 'mime' };
	if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
		return { ok: false, reason: 'size' };
	}
	return { ok: true, mime: input.mime, ext: ALLOWED_IMAGE_MIMES[input.mime] };
}

/**
 * Build the storage key for a new upload: `uploads/<yyyy>/<mm>/<slug>-<id>.<ext>`.
 * The slug comes from the original filename (safe chars only); the random id
 * makes keys collision-free. Keys stay [a-z0-9/._-] so they never need URL
 * escaping in imgproxy `plain/s3://…` source URLs.
 */
export function mediaKeyFor(
	filename: string,
	mime: AllowedImageMime,
	{ now, id }: { now: Date; id: string }
): string {
	const base = filename.replace(/\.[^.]*$/, '');
	const slug =
		base
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'file';
	const yyyy = now.getUTCFullYear();
	const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
	const short = id.replace(/-/g, '').slice(0, 8);
	return `uploads/${yyyy}/${mm}/${slug}-${short}.${ALLOWED_IMAGE_MIMES[mime]}`;
}
