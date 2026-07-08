import { error } from '@sveltejs/kit';
import { PILLARS_BY_SLUG } from '$lib/config';
import { getSite } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const site = getSite();
	const def = PILLARS_BY_SLUG.get(params.pillar);
	if (!def || !site.pillars.includes(params.pillar)) {
		error(404);
	}
	return { pillar: def };
};
