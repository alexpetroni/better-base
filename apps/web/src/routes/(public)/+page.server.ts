import { PILLARS_BY_SLUG } from '$lib/config';
import { getSite } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const site = getSite();
	// Site config is the source of truth for which pillars are active.
	const pillars = site.pillars.map((slug) => {
		const def = PILLARS_BY_SLUG.get(slug);
		if (!def) throw new Error(`Unknown pillar slug "${slug}"`);
		return def;
	});
	return { pillars };
};
