import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import type { ImageSources } from '$lib/modules/media';
import { imgSources, media } from '$lib/modules/media/server';
import { removeFromCart, setCartQty } from '$lib/modules/shop';
import {
	createCheckoutFromCart,
	getStripeGateway,
	loadCartDetails
} from '$lib/modules/shop/server';
import { readCart, writeCart } from '$lib/server/cart';
import { getSite } from '$lib/server/site';
import { inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

export interface CartPageLine {
	productId: string;
	slug: string;
	name: string;
	priceCents: number;
	currency: string;
	qty: number;
	lineTotalCents: number;
	available: boolean;
	cover: ImageSources | null;
}

export const load: PageServerLoad = async ({ cookies }) => {
	const site = getSite();
	const items = readCart(cookies);
	const details = await loadCartDetails({ db: getDb() }, items, site.pillars);

	const coverIds = details.lines
		.map((l) => l.product.coverMediaId)
		.filter((id): id is string => !!id);
	const coverRows = coverIds.length
		? await getDb().select().from(media).where(inArray(media.id, coverIds))
		: [];
	const coverById = new Map(coverRows.map((r) => [r.id, r]));

	const lines: CartPageLine[] = details.lines.map((line) => {
		const cover = line.product.coverMediaId
			? (coverById.get(line.product.coverMediaId) ?? null)
			: null;
		return {
			productId: line.product.id,
			slug: line.product.slug,
			name: line.product.name,
			priceCents: line.product.priceCents,
			currency: line.product.currency,
			qty: line.qty,
			lineTotalCents: line.lineTotalCents,
			available: line.available,
			cover: cover?.key ? imgSources(cover, { w: 160, h: 120, fit: 'fill' }) : null
		};
	});

	return { lines, totalCents: details.totalCents, currency: details.currency };
};

export const actions: Actions = {
	setQty: async ({ request, cookies }) => {
		const form = await request.formData();
		const productId = String(form.get('productId') ?? '');
		const qty = Number(form.get('qty'));
		if (!productId || !Number.isFinite(qty)) return fail(400);
		writeCart(cookies, setCartQty(readCart(cookies), productId, Math.trunc(qty)));
		return { updated: true };
	},

	remove: async ({ request, cookies }) => {
		const form = await request.formData();
		const productId = String(form.get('productId') ?? '');
		if (!productId) return fail(400);
		writeCart(cookies, removeFromCart(readCart(cookies), productId));
		return { updated: true };
	},

	checkout: async ({ cookies }) => {
		const site = getSite();
		const outcome = await createCheckoutFromCart(
			{
				db: getDb(),
				gateway: getStripeGateway(),
				baseUrl: (env.PUBLIC_SITE_URL ?? '').replace(/\/$/, '')
			},
			{ items: readCart(cookies), sitePillarSlugs: site.pillars }
		);
		if (!outcome.ok) {
			return fail(400, { checkoutError: outcome.error, detail: outcome.detail ?? '' });
		}
		redirect(303, outcome.url);
	}
};
