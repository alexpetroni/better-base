import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getBySlug, renderArticleHtml } from '$lib/modules/blog/server';
import { getImgproxyConfig, imgSources, imgUrl } from '$lib/modules/media/server';
import { canonicalUrl } from '$lib/seo';
import { getSite } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const site = getSite();
	// Published only: drafts 404 publicly.
	const found = await getBySlug({ db: getDb() }, params.slug);
	if (!found) error(404);

	const { article, cover } = found;
	const html = await renderArticleHtml({ db: getDb() }, getImgproxyConfig(), article.bodyMd);
	const canonical = canonicalUrl(`/blog/${article.slug}`);
	const description = article.seoDescription || article.excerpt;
	// Fixed-size social card through imgproxy (og:image wants 1200×630).
	const ogImage = cover?.key
		? imgUrl(cover.key, { w: 1200, h: 630, fit: 'fill', format: 'jpg' })
		: null;

	const jsonLd: Record<string, unknown> = {
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: article.title,
		description,
		mainEntityOfPage: canonical,
		datePublished: article.publishedAt?.toISOString(),
		dateModified: article.updatedAt.toISOString(),
		...(ogImage ? { image: [ogImage] } : {}),
		author: { '@type': 'Organization', name: site.name },
		publisher: { '@type': 'Organization', name: site.name }
	};

	return {
		article: {
			title: article.title,
			excerpt: article.excerpt,
			publishedAt: article.publishedAt,
			seoTitle: article.seoTitle,
			seoDescription: article.seoDescription
		},
		html,
		cover: cover?.key ? imgSources(cover, { w: 960 }) : null,
		canonical,
		ogImage,
		ogImageAlt: cover?.alt ?? '',
		jsonLd
	};
};
