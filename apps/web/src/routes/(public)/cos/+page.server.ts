import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import type { ImageSources } from '$lib/modules/media';
import { imgSources, media } from '$lib/modules/media/server';
import {
	clampLineToStock,
	removeFromCart,
	setCartQty,
	shippingOptionsForCart
} from '$lib/modules/shop';
import {
	createCheckoutFromCart,
	getStripeGateway,
	loadCartDetails,
	parseBuyerCompanyForm,
	products
} from '$lib/modules/shop/server';
import { readCart, writeCart } from '$lib/server/cart';
import { formStr } from '$lib/server/forms';
import { getSite } from '$lib/server/site';
import { eq, inArray } from 'drizzle-orm';
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
	/** Units in stock (the input's cap); null = untracked. */
	maxQty: number | null;
	cover: ImageSources | null;
}

export const load: PageServerLoad = async ({ cookies, locals }) => {
	const site = getSite();
	const items = readCart(cookies);
	const details = await loadCartDetails({ db: getDb() }, items, site.pillars);
	const settings = await locals.settings();

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
			maxQty: line.maxQty,
			cover: cover?.key ? imgSources(cover, { w: 160, h: 120, fit: 'fill' }) : null
		};
	});

	return {
		lines,
		totalCents: details.totalCents,
		currency: details.currency,
		// Settings-driven delivery choice, priced for THIS cart's goods total.
		shippingOptions: shippingOptionsForCart(settings, details.totalCents),
		shippingNote: settings['shop.shippingNote']
	};
};

export const actions: Actions = {
	setQty: async ({ request, cookies }) => {
		const form = await request.formData();
		const productId = String(form.get('productId') ?? '');
		const qty = Number(form.get('qty'));
		if (!productId || !Number.isFinite(qty)) return fail(400);
		// Clamp to the tracked stock: the page shows the cap, the cookie never
		// carries more than can ship (audit P1 "quantity vs stock").
		const [row] = await getDb()
			.select({ stock: products.stock })
			.from(products)
			.where(eq(products.id, productId));
		writeCart(
			cookies,
			clampLineToStock(
				setCartQty(readCart(cookies), productId, Math.trunc(qty)),
				productId,
				row?.stock ?? null
			)
		);
		return { updated: true };
	},

	remove: async ({ request, cookies }) => {
		const form = await request.formData();
		const productId = String(form.get('productId') ?? '');
		if (!productId) return fail(400);
		writeCart(cookies, removeFromCart(readCart(cookies), productId));
		return { updated: true };
	},

	checkout: async ({ request, cookies, locals }) => {
		const site = getSite();
		// Optional B2B fields for the invoice; empty inputs mean a consumer sale.
		const form = await request.formData();
		const companyValues = {
			name: formStr(form, 'companyName'),
			cui: formStr(form, 'companyCui'),
			regCom: formStr(form, 'companyRegCom'),
			// The company seat (FIX-12): the invoice's buyer address for B2B.
			street: formStr(form, 'companyStreet'),
			city: formStr(form, 'companyCity'),
			county: formStr(form, 'companyCounty'),
			postalCode: formStr(form, 'companyPostalCode')
		};
		const company = parseBuyerCompanyForm(companyValues);
		if (!company.ok) {
			return fail(400, { checkoutError: company.error, detail: '', companyValues });
		}
		const settings = await locals.settings();
		const outcome = await createCheckoutFromCart(
			{
				db: getDb(),
				gateway: getStripeGateway(),
				baseUrl: (env.PUBLIC_SITE_URL ?? '').replace(/\/$/, '')
			},
			{
				items: readCart(cookies),
				sitePillarSlugs: site.pillars,
				shippingSettings: settings,
				// The standard option is the no-JS form's pre-checked default.
				shippingOptionId: formStr(form, 'shippingOption') || 'standard',
				buyerCompany: company.value,
				// Card-only unless the operator opened all methods in settings.
				paymentSettings: settings
			}
		);
		if (!outcome.ok) {
			return fail(400, { checkoutError: outcome.error, detail: outcome.detail ?? '' });
		}
		redirect(303, outcome.url);
	}
};
