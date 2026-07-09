import { getDb } from '$lib/db';
import { listPublishedForSitemap } from '$lib/modules/blog/server';
import { listPages } from '$lib/modules/pages/server';
import { listVisibleProducts } from '$lib/modules/shop/server';
import { canonicalUrl } from '$lib/seo';
import { getSite } from '$lib/server/site';
import type { RequestHandler } from './$types';

function xmlEscape(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export const GET: RequestHandler = async () => {
	const site = getSite();
	const db = getDb();
	const [articles, products, pages] = await Promise.all([
		listPublishedForSitemap({ db }, site.pillars),
		listVisibleProducts({ db }, { pillarSlugs: site.pillars }),
		listPages({ db })
	]);

	const staticPaths = [
		'/',
		'/blog',
		'/magazin',
		...site.pillars.map((slug) => `/sanatate/${slug}`)
	];
	const entries = [
		...staticPaths.map((path) => ({ loc: canonicalUrl(path), lastmod: null as string | null })),
		...articles.map((a) => ({
			loc: canonicalUrl(`/blog/${a.slug}`),
			lastmod: a.updatedAt.toISOString()
		})),
		...products.map(({ product }) => ({
			loc: canonicalUrl(`/magazin/${product.slug}`),
			lastmod: product.updatedAt.toISOString()
		})),
		...pages.map((p) => ({
			loc: canonicalUrl(`/pagini/${p.slug}`),
			lastmod: p.updatedAt.toISOString()
		}))
	];

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
	.map(
		(e) =>
			`\t<url><loc>${xmlEscape(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`
	)
	.join('\n')}
</urlset>
`;

	return new Response(body, {
		headers: { 'content-type': 'application/xml; charset=utf-8' }
	});
};
