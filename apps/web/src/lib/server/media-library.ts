import type { LibraryImage } from '$lib/components/MediaPicker.svelte';
import { getDb } from '$lib/db';
import { articlesMediaReferenceCheck } from '$lib/modules/blog/server';
import { imgSources, listMedia, type MediaReferenceCheck } from '$lib/modules/media/server';
import { productsMediaReferenceCheck } from '$lib/modules/shop/server';

/**
 * Every table that stores media ids/keys, wired into `deleteMedia` by the
 * media library's delete action. A NEW module that references media MUST add
 * its check here (media-library.spec.ts pins the list).
 */
export const MEDIA_REFERENCE_CHECKS: MediaReferenceCheck[] = [
	articlesMediaReferenceCheck,
	productsMediaReferenceCheck
];

/** All pickable library images with signed thumbs, for MediaPicker loads. */
export async function loadLibraryImages(): Promise<LibraryImage[]> {
	const rows = await listMedia({ db: getDb() });
	return rows
		.filter((row) => row.kind === 'image' && row.key)
		.map((row) => ({
			id: row.id,
			key: row.key!,
			filename: row.filename ?? '',
			alt: row.alt,
			thumb: imgSources(row, { w: 240, h: 180, fit: 'fill' })
		}));
}
