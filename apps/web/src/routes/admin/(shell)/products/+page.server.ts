import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import {
	createProduct,
	getStripeGateway,
	listProducts,
	syncProductToStripe
} from '$lib/modules/shop/server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const statusParam = url.searchParams.get('status');
	const status =
		statusParam === 'draft' || statusParam === 'active' || statusParam === 'archived'
			? statusParam
			: undefined;
	const search = url.searchParams.get('q') ?? '';
	const products = await listProducts({ db: getDb() }, { status, search });
	return { products, filter: { status: status ?? 'all', search } };
};

export const actions: Actions = {
	create: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		const result = await createProduct({ db: getDb() }, { name });
		if (!result.ok) return fail(400, { error: result.error });
		// Mirror into Stripe right away (no price yet → product only). A gateway
		// failure is not fatal here: the next editor save retries the sync.
		await syncProductToStripe({ db: getDb(), gateway: getStripeGateway() }, result.value.id);
		redirect(303, `/admin/products/${result.value.id}`);
	}
};
