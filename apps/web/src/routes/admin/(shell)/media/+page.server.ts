import { error, fail } from '@sveltejs/kit';
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
import { recordAdminAudit } from '$lib/modules/auth';
import { formStr, requireStaff } from '$lib/server/forms';
import { MEDIA_REFERENCE_CHECKS } from '$lib/server/media-library';
import { parsePageParam, pastLastPage } from '$lib/util/page';
import type { Actions, PageServerLoad } from './$types';

export interface MediaListItem {
	row: MediaRow;
	/** Signed thumbnail sources; null for video embeds. */
	thumb: ImageSources | null;
}

export const load: PageServerLoad = async ({ url }) => {
	// Paginated (FIX-15): the library used to read every row and decode a
	// blurhash PNG per row on every load. Thumbnails skip the placeholder.
	const page = parsePageParam(url.searchParams.get('page'));
	const list = await listMedia({ db: getDb() }, { page });
	if (pastLastPage(page, list.pageCount)) error(404);
	const items: MediaListItem[] = list.items.map((row) => ({
		row,
		thumb: row.key ? imgSources(row, { w: 320, h: 240, fit: 'fill', placeholder: false }) : null
	}));
	return {
		items,
		page: list.page,
		pageCount: list.pageCount,
		total: list.total,
		constraints: { mimes: Object.keys(ALLOWED_IMAGE_MIMES), maxBytes: MAX_UPLOAD_BYTES }
	};
};

export const actions: Actions = {
	updateAlt: async ({ request, locals }) => {
		requireStaff(locals);
		const form = await request.formData();
		const id = formStr(form, 'id');
		const alt = formStr(form, 'alt').trim();
		const result = await updateMediaAlt({ db: getDb() }, id, alt);
		if (!result.ok) return fail(404, { error: result.error });
		return { updated: id };
	},

	delete: async ({ request, locals }) => {
		const user = requireStaff(locals);
		const form = await request.formData();
		const id = formStr(form, 'id');
		const result = await deleteMedia(
			{ db: getDb(), storage: getStorage(), referenceChecks: MEDIA_REFERENCE_CHECKS },
			id
		);
		if (!result.ok) {
			if (result.error === 'referenced') {
				return fail(409, { error: result.error, detail: result.detail ?? '' });
			}
			return fail(404, { error: result.error });
		}
		await recordAdminAudit(getDb(), { actor: user.email, action: 'media-delete', target: id });
		return { deleted: id };
	}
};
