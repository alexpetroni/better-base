import { getDb } from '$lib/db';
import type { ImageSources } from '$lib/modules/media';
import { imgSources } from '$lib/modules/media/server';
import { isOutOfStock, listVisibleProducts } from '$lib/modules/shop/server';
import { canonicalUrl } from '$lib/seo';
import { getSite, resolveSitePillars } from '$lib/server/site';
import type { PageServerLoad } from './$types';

export interface ProductCard {
	slug: string;
	name: string;
	priceCents: number;
	currency: string;
	outOfStock: boolean;
	cover: ImageSources | null;
}

export const load: PageServerLoad = async ({ url }) => {
	const site = getSite();
	const pillarParam = url.searchParams.get('pilon') ?? undefined;
	const pillarFilter = site.pillars.includes(pillarParam ?? '') ? pillarParam : undefined;

	const items = await listVisibleProducts(
		{ db: getDb() },
		{ pillarSlugs: site.pillars, pillarFilter }
	);

	const cards: ProductCard[] = items.map(({ product, cover }) => ({
		slug: product.slug,
		name: product.name,
		priceCents: product.priceCents,
		currency: product.currency,
		outOfStock: isOutOfStock(product),
		cover: cover?.key ? imgSources(cover, { w: 480, h: 360, fit: 'fill' }) : null
	}));

	// A pillar filter bar only makes sense on multi-pillar sites (better-life).
	const pillarFilters = site.pillars.length > 1 ? resolveSitePillars() : [];

	return {
		cards,
		pillarFilters,
		activeFilter: pillarFilter ?? null,
		canonical: canonicalUrl('/magazin')
	};
};
