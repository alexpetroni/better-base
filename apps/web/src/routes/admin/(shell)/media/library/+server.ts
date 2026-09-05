import { json } from '@sveltejs/kit';
import { requireStaff } from '$lib/server/forms';
import { loadLibraryImages } from '$lib/server/media-library';
import { parsePageParam } from '$lib/util/page';
import type { RequestHandler } from './$types';

/**
 * One page of the picker's library (`{ items, page, pageCount }`), for the
 * MediaPicker's next/previous buttons; the editor's load ships page 1.
 * /admin/* is staff-gated by hooks.server.ts; requireStaff is the second layer.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	requireStaff(locals);
	return json(await loadLibraryImages(parsePageParam(url.searchParams.get('page'))));
};
