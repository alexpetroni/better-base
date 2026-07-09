import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { parseLeiToCents } from '$lib/util/money';
import type { ProductStatus } from '$lib/modules/shop';
import {
	getProduct,
	getStripeGateway,
	syncProductToStripe,
	updateProduct,
	type ProductPatch
} from '$lib/modules/shop/server';
import { failResult, formStr, formStrAll } from '$lib/server/forms';
import { loadLibraryImages } from '$lib/server/media-library';
import { resolveSitePillars } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getProduct({ db: getDb() }, params.id);
	if (!found) error(404);

	return {
		product: found.product,
		pillarSlugs: found.pillarSlugs,
		sitePillars: resolveSitePillars(),
		library: await loadLibraryImages()
	};
};

const STATUSES: ProductStatus[] = ['draft', 'active', 'archived'];

type ParseError = { error: string; detail: string };

function patchFrom(form: FormData): ProductPatch | ParseError {
	const priceCents = parseLeiToCents(formStr(form, 'price'));
	if (priceCents === null) return { error: 'invalid-price', detail: '' };

	const stockRaw = formStr(form, 'stock').trim();
	let stock: number | null = null;
	if (stockRaw !== '') {
		stock = Number(stockRaw);
		if (!Number.isInteger(stock) || stock < 0) return { error: 'invalid-stock', detail: '' };
	}

	const statusRaw = formStr(form, 'status');
	return {
		name: formStr(form, 'name'),
		slug: formStr(form, 'slug'),
		descriptionMd: formStr(form, 'descriptionMd'),
		priceCents,
		stock,
		status: STATUSES.includes(statusRaw as ProductStatus)
			? (statusRaw as ProductStatus)
			: undefined,
		coverMediaId: formStr(form, 'coverMediaId') || null,
		gallery: formStrAll(form, 'gallery').filter(Boolean),
		pillarSlugs: formStrAll(form, 'pillars')
	};
}

export const actions: Actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const patch = patchFrom(form);
		if ('error' in patch) return fail(400, patch);

		const result = await updateProduct({ db: getDb() }, params.id, patch);
		if (!result.ok) return failResult(result);

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
