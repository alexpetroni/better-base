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
import { failResult, formStr, formStrAll, requireAdmin } from '$lib/server/forms';
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

	// Stock (audit P2 — the absolute write raced the webhook decrement):
	// a relative "adaugă N bucăți" is `stock + N` in SQL; an absolute edit is
	// written only when the operator actually changed the field, guarded by
	// the value the form was loaded with (a sale in between → stock-changed).
	const stockRaw = formStr(form, 'stock').trim();
	const loadedRaw = formStr(form, 'stockLoaded').trim();
	const deltaRaw = formStr(form, 'stockDelta').trim();
	let stockPatch: Pick<ProductPatch, 'stock' | 'expectedStock' | 'stockDelta'> = {};
	if (deltaRaw !== '') {
		const delta = Number(deltaRaw);
		if (!Number.isInteger(delta) || delta <= 0) return { error: 'invalid-stock', detail: '' };
		stockPatch = { stockDelta: delta };
	} else if (stockRaw !== loadedRaw) {
		let stock: number | null = null;
		if (stockRaw !== '') {
			stock = Number(stockRaw);
			if (!Number.isInteger(stock) || stock < 0) return { error: 'invalid-stock', detail: '' };
		}
		const loaded = loadedRaw === '' ? null : Number(loadedRaw);
		if (loaded !== null && !Number.isInteger(loaded)) return { error: 'invalid-stock', detail: '' };
		stockPatch = { stock, expectedStock: loaded };
	}

	const statusRaw = formStr(form, 'status');
	return {
		name: formStr(form, 'name'),
		slug: formStr(form, 'slug'),
		descriptionMd: formStr(form, 'descriptionMd'),
		priceCents,
		...stockPatch,
		status: STATUSES.includes(statusRaw as ProductStatus)
			? (statusRaw as ProductStatus)
			: undefined,
		coverMediaId: formStr(form, 'coverMediaId') || null,
		gallery: formStrAll(form, 'gallery').filter(Boolean),
		pillarSlugs: formStrAll(form, 'pillars')
	};
}

export const actions: Actions = {
	save: async ({ request, params, locals }) => {
		requireAdmin(locals);
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
			// The form re-bases its stock buffer on what was actually saved.
			stock: result.value.stock,
			syncError: sync.ok ? '' : (sync.detail ?? sync.error)
		};
	}
};
