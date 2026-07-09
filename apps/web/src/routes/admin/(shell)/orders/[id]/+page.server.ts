import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getOrderWithItems } from '$lib/modules/shop/server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getOrderWithItems({ db: getDb() }, params.id);
	if (!found) error(404);
	return found;
};
