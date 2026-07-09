import { getDb } from '$lib/db';
import {
	createProduct,
	getStripeGateway,
	listProducts,
	syncProductToStripe
} from '$lib/modules/shop/server';
import { createEntityAction, parseListFilter } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const { status, search, filter } = parseListFilter(url, ['draft', 'active', 'archived']);
	const products = await listProducts({ db: getDb() }, { status, search });
	return { products, filter };
};

export const actions: Actions = {
	create: createEntityAction({
		field: 'name',
		create: (name) => createProduct({ db: getDb() }, { name }),
		// Mirror into Stripe right away (no price yet → product only). A gateway
		// failure is not fatal here: the next editor save retries the sync.
		afterCreate: (product) =>
			syncProductToStripe({ db: getDb(), gateway: getStripeGateway() }, product.id),
		redirectTo: (product) => `/admin/products/${product.id}`
	})
};
