import { getSite } from '$lib/server/site';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const site = getSite();
	return {
		site: {
			id: site.id,
			name: site.name,
			nav: site.nav,
			theme: site.theme
		}
	};
};
