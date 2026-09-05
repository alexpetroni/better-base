import type { LibraryImage, LibraryPage } from '$lib/components/MediaPicker.svelte';
import { getDb } from '$lib/db';
import { articlesMediaReferenceCheck } from '$lib/modules/blog/server';
import {
	imgSources,
	listMedia,
	MEDIA_PAGE_SIZE,
	type MediaReferenceCheck
} from '$lib/modules/media/server';
import { quizzesMediaReferenceCheck } from '$lib/modules/quiz/server';
import { productsMediaReferenceCheck } from '$lib/modules/shop/server';

/**
 * Every table that stores media ids/keys, wired into `deleteMedia` by the
 * media library's delete action. A NEW module that references media MUST add
 * its check here (media-library.spec.ts pins the list).
 */
export const MEDIA_REFERENCE_CHECKS: MediaReferenceCheck[] = [
	articlesMediaReferenceCheck,
	productsMediaReferenceCheck,
	quizzesMediaReferenceCheck
];

/**
 * One page of pickable library images with signed thumbs, newest first, for
 * MediaPicker (the editor loads page 1; the picker fetches the rest from
 * `/admin/media/library?page=N`). Thumbnails skip the blurhash placeholder:
 * decoding a PNG per row per editor load was the cost the audit flagged
 * (FIX-15), and a 240px thumb grid does not need one.
 */
export async function loadLibraryImages(page = 1): Promise<LibraryPage> {
	const list = await listMedia({ db: getDb() }, { page, pageSize: MEDIA_PAGE_SIZE });
	const items: LibraryImage[] = list.items
		.filter((row) => row.kind === 'image' && row.key)
		.map((row) => ({
			id: row.id,
			key: row.key!,
			filename: row.filename ?? '',
			alt: row.alt,
			thumb: imgSources(row, { w: 240, h: 180, fit: 'fill', placeholder: false })
		}));
	return { items, page: list.page, pageCount: list.pageCount };
}
