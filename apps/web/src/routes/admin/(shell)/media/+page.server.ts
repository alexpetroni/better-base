import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import {
	ALLOWED_IMAGE_MIMES,
	MAX_UPLOAD_BYTES,
	type ImageSources,
	type MediaRow
} from '$lib/modules/media';
import {
	deleteMedia,
	getStorage,
	imgSources,
	listMedia,
	updateMediaAlt
} from '$lib/modules/media/server';
import { formStr } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export interface MediaListItem {
	row: MediaRow;
	/** Signed thumbnail sources; null for video embeds. */
	thumb: ImageSources | null;
}

export const load: PageServerLoad = async () => {
	const rows = await listMedia({ db: getDb() });
	const items: MediaListItem[] = rows.map((row) => ({
		row,
		thumb: row.key ? imgSources(row, { w: 320, h: 240, fit: 'fill' }) : null
	}));
	return {
		items,
		constraints: { mimes: Object.keys(ALLOWED_IMAGE_MIMES), maxBytes: MAX_UPLOAD_BYTES }
	};
};

export const actions: Actions = {
	updateAlt: async ({ request }) => {
		const form = await request.formData();
		const id = formStr(form, 'id');
		const alt = formStr(form, 'alt').trim();
		const result = await updateMediaAlt({ db: getDb() }, id, alt);
		if (!result.ok) return fail(404, { error: result.error });
		return { updated: id };
	},

	delete: async ({ request }) => {
		const form = await request.formData();
		const id = formStr(form, 'id');
		const result = await deleteMedia({ db: getDb(), storage: getStorage() }, id);
		if (!result.ok) {
			if (result.error === 'referenced') {
				return fail(409, { error: result.error, detail: result.detail ?? '' });
			}
			return fail(404, { error: result.error });
		}
		return { deleted: id };
	}
};
