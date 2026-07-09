import { getDb } from '$lib/db';
import { listPublished } from '$lib/modules/blog/server';
import type { ImageSources } from '$lib/modules/media';
import { imgSources } from '$lib/modules/media/server';
import { canonicalUrl } from '$lib/seo';
import { getSite } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export interface BlogCard {
	slug: string;
	title: string;
	excerpt: string;
	publishedAt: Date | null;
	cover: ImageSources | null;
}

export const load: PageServerLoad = async ({ url }) => {
	const site = getSite();
	const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
	const list = await listPublished({ db: getDb() }, { pillarSlugs: site.pillars, page });

	const cards: BlogCard[] = list.items.map(({ article, cover }) => ({
		slug: article.slug,
		title: article.title,
		excerpt: article.excerpt,
		publishedAt: article.publishedAt,
		cover: cover?.key ? imgSources(cover, { w: 480, h: 300, fit: 'fill' }) : null
	}));

	return {
		cards,
		page: list.page,
		pageCount: list.pageCount,
		canonical: canonicalUrl(page > 1 ? `/blog?page=${page}` : '/blog')
	};
};
