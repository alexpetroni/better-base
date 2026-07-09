import type { LibraryImage } from '$lib/components/MediaPicker.svelte';
import { getDb } from '$lib/db';
import { imgSources, listMedia } from '$lib/modules/media/server';

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
