import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { renderMarkdown } from '$lib/modules/blog/server';
import { getPageBySlug } from '$lib/modules/pages/server';
import { canonicalUrl } from '$lib/seo';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const page = await getPageBySlug({ db: getDb() }, params.slug);
	if (!page) error(404);
	return {
		page: {
			title: page.title,
			seoDescription: page.seoDescription,
			// Simple pages carry no media: refs — plain markdown render.
			html: renderMarkdown(page.bodyMd),
			updatedAt: page.updatedAt
		},
		canonical: canonicalUrl(`/pagini/${page.slug}`)
	};
};
