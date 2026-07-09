import { error } from '@sveltejs/kit';
import { PILLARS_BY_SLUG } from '$lib/config';
import { getDb } from '$lib/db';
import { listPublished } from '$lib/modules/blog/server';
import { imgSources } from '$lib/modules/media/server';
import { canonicalUrl } from '$lib/seo';
import { getSite } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const site = getSite();
	const def = PILLARS_BY_SLUG.get(params.pillar);
	if (!def || !site.pillars.includes(params.pillar)) {
		error(404);
	}

	// Latest articles tagged to THIS pillar (it is active, so it may filter).
	const latest = await listPublished(
		{ db: getDb() },
		{ pillarSlugs: [params.pillar], page: 1, pageSize: 6 }
	);

	return {
		pillar: def,
		canonical: canonicalUrl(`/sanatate/${def.slug}`),
		articles: latest.items.map(({ article, cover }) => ({
			slug: article.slug,
			title: article.title,
			excerpt: article.excerpt,
			publishedAt: article.publishedAt,
			cover: cover?.key ? imgSources(cover, { w: 480, h: 300, fit: 'fill' }) : null
		}))
	};
};
