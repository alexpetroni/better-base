import { error, fail } from '@sveltejs/kit';
import { PILLARS_BY_SLUG } from '$lib/config';
import { getDb } from '$lib/db';
import { parseLeiToCents, type ProductStatus } from '$lib/modules/shop';
import {
	getProduct,
	getStripeGateway,
	syncProductToStripe,
	updateProduct,
	type ProductPatch,
	type ShopResult
} from '$lib/modules/shop/server';
import { loadLibraryImages } from '$lib/server/media-library';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getProduct({ db: getDb() }, params.id);
	if (!found) error(404);

	const site = getSite();
	const sitePillars = site.pillars.map((slug) => ({
		slug,
		name: PILLARS_BY_SLUG.get(slug)?.name ?? slug
	}));

	return {
		product: found.product,
		pillarSlugs: found.pillarSlugs,
		sitePillars,
		library: await loadLibraryImages()
	};
};

const STATUSES: ProductStatus[] = ['draft', 'active', 'archived'];

type ParseError = { error: string; detail: string };

function patchFrom(form: FormData): ProductPatch | ParseError {
	const priceCents = parseLeiToCents(String(form.get('price') ?? ''));
	if (priceCents === null) return { error: 'invalid-price', detail: '' };

	const stockRaw = String(form.get('stock') ?? '').trim();
	let stock: number | null = null;
	if (stockRaw !== '') {
		stock = Number(stockRaw);
		if (!Number.isInteger(stock) || stock < 0) return { error: 'invalid-stock', detail: '' };
	}

	const statusRaw = String(form.get('status') ?? '');
	const cover = String(form.get('coverMediaId') ?? '');
	return {
		name: String(form.get('name') ?? ''),
		slug: String(form.get('slug') ?? ''),
		descriptionMd: String(form.get('descriptionMd') ?? ''),
		priceCents,
		stock,
		status: STATUSES.includes(statusRaw as ProductStatus)
			? (statusRaw as ProductStatus)
			: undefined,
		coverMediaId: cover || null,
		gallery: form.getAll('gallery').map(String).filter(Boolean),
		pillarSlugs: form.getAll('pillars').map(String)
	};
}

function failOf(result: ShopResult<unknown> & { ok: false }) {
	return fail(result.error === 'not-found' ? 404 : 400, {
		error: result.error,
		detail: result.detail ?? ''
	});
}

export const actions: Actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const patch = patchFrom(form);
		if ('error' in patch) return fail(400, patch);

		const result = await updateProduct({ db: getDb() }, params.id, patch);
		if (!result.ok) return failOf(result);

		// Mirror into the Stripe catalog on every save. A gateway failure keeps
		// the save (retried on the next save) and is surfaced as a warning.
		const sync = await syncProductToStripe({ db: getDb(), gateway: getStripeGateway() }, params.id);
		return {
			saved: true,
			slug: result.value.slug,
			syncError: sync.ok ? '' : (sync.detail ?? sync.error)
		};
	}
};
