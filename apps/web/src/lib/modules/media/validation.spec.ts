import { describe, expect, it } from 'vitest';
import {
	ALLOWED_IMAGE_MIMES,
	MAX_UPLOAD_BYTES,
	mediaKeyFor,
	validateUpload
} from './validation.ts';

describe('validateUpload', () => {
	it('accepts every allowed image mime with its extension', () => {
		for (const [mime, ext] of Object.entries(ALLOWED_IMAGE_MIMES)) {
			expect(validateUpload({ mime, size: 1024 })).toEqual({ ok: true, mime, ext });
		}
	});

	it.each(['application/pdf', 'video/mp4', 'text/html', 'image/tiff', ''])(
		'rejects mime %s',
		(mime) => {
			expect(validateUpload({ mime, size: 1024 })).toEqual({ ok: false, reason: 'mime' });
		}
	);

	it('accepts exactly the max size and rejects one byte more', () => {
		expect(validateUpload({ mime: 'image/png', size: MAX_UPLOAD_BYTES }).ok).toBe(true);
		expect(validateUpload({ mime: 'image/png', size: MAX_UPLOAD_BYTES + 1 })).toEqual({
			ok: false,
			reason: 'size'
		});
	});

	it.each([0, -5, 1.5, NaN])('rejects size %s', (size) => {
		expect(validateUpload({ mime: 'image/png', size })).toEqual({ ok: false, reason: 'size' });
	});
});

describe('mediaKeyFor', () => {
	const ctx = { now: new Date('2026-07-08T12:00:00Z'), id: '3f9a2b1c-4d5e-6f70-8192-a3b4c5d6e7f8' };

	it('builds uploads/yyyy/mm/slug-shortid.ext', () => {
		expect(mediaKeyFor('Sunset.JPG', 'image/jpeg', ctx)).toBe(
			'uploads/2026/07/sunset-3f9a2b1c.jpg'
		);
	});

	it('slugifies Romanian diacritics and punctuation', () => {
		expect(mediaKeyFor('Pădurea Verde (mărită)!.png', 'image/png', ctx)).toBe(
			'uploads/2026/07/padurea-verde-marita-3f9a2b1c.png'
		);
	});

	it('falls back to "file" for unusable names and never emits unsafe chars', () => {
		const key = mediaKeyFor('()!?.svg', 'image/svg+xml', ctx);
		expect(key).toBe('uploads/2026/07/file-3f9a2b1c.svg');
		expect(mediaKeyFor('日本語.webp', 'image/webp', ctx)).toMatch(
			/^uploads\/2026\/07\/[a-z0-9-]+-3f9a2b1c\.webp$/
		);
	});

	it('caps very long names', () => {
		const key = mediaKeyFor(`${'a'.repeat(200)}.gif`, 'image/gif', ctx);
		expect(key.length).toBeLessThan(100);
		expect(key.endsWith('-3f9a2b1c.gif')).toBe(true);
	});
});
