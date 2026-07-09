import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { renderArticleHtml } from '$lib/modules/blog/server';
import type { ImageSources } from '$lib/modules/media';
import { getImgproxyConfig, imgSources } from '$lib/modules/media/server';
import { addToCart } from '$lib/modules/shop';
import { getProductBySlug, isOutOfStock } from '$lib/modules/shop/server';
import { canonicalUrl } from '$lib/seo';
import { readCart, writeCart } from '$lib/server/cart';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const site = getSite();
	const found = await getProductBySlug({ db: getDb() }, params.slug, {
		sitePillarSlugs: site.pillars
	});
	if (!found) error(404);
	const { product, cover, galleryMedia } = found;

	const gallery: ImageSources[] = galleryMedia
		.filter((row) => row.key)
		.map((row) => imgSources(row, { w: 768 }));

	return {
		product: {
			id: product.id,
			slug: product.slug,
			name: product.name,
			priceCents: product.priceCents,
			currency: product.currency,
			outOfStock: isOutOfStock(product)
		},
		cover: cover?.key ? imgSources(cover, { w: 768 }) : null,
		gallery,
		// Same sanitized markdown pipeline as articles (supports media: refs).
		descriptionHtml: await renderArticleHtml(
			{ db: getDb() },
			getImgproxyConfig(),
			product.descriptionMd
		),
		canonical: canonicalUrl(`/magazin/${product.slug}`)
	};
};

export const actions: Actions = {
	add: async ({ params, request, cookies }) => {
		const site = getSite();
		const found = await getProductBySlug({ db: getDb() }, params.slug, {
			sitePillarSlugs: site.pillars
		});
		if (!found || isOutOfStock(found.product)) error(400, 'Product unavailable');

		const form = await request.formData();
		const qty = Math.max(1, Number(form.get('qty')) || 1);
		writeCart(cookies, addToCart(readCart(cookies), found.product.id, qty));
		redirect(303, '/cos');
	}
};
