import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { StripeGateway } from './gateway.ts';
import { products, type ProductRow } from './schema.ts';

/**
 * Mirror a product into the Stripe catalog: upsert the product, and — since
 * Stripe prices are immutable — create a new price and archive the replaced
 * one whenever the amount or currency changed. Idempotent: re-syncing an
 * unchanged product only refreshes the product's name/description.
 */

export interface SyncDeps {
	db: Db;
	gateway: StripeGateway;
}

export type SyncOutcome =
	| { ok: true; product: ProductRow; priceChanged: boolean }
	| { ok: false; error: 'not-found' | 'gateway'; detail?: string };

export async function syncProductToStripe(deps: SyncDeps, productId: string): Promise<SyncOutcome> {
	const [row] = await deps.db.select().from(products).where(eq(products.id, productId));
	if (!row) return { ok: false, error: 'not-found' };

	try {
		const productInput = { name: row.name, description: row.descriptionMd };
		let stripeProductId = row.stripeProductId;
		if (stripeProductId) {
			await deps.gateway.updateProduct(stripeProductId, productInput);
		} else {
			stripeProductId = await deps.gateway.createProduct(productInput);
		}

		let stripePriceId = row.stripePriceId;
		let priceChanged = false;
		// A zero price means "not priced yet" — nothing to mirror.
		if (row.priceCents > 0) {
			const current = stripePriceId ? await deps.gateway.getPrice(stripePriceId) : null;
			if (
				!current ||
				current.unitAmountCents !== row.priceCents ||
				current.currency !== row.currency
			) {
				const newPriceId = await deps.gateway.createPrice({
					productId: stripeProductId,
					unitAmountCents: row.priceCents,
					currency: row.currency
				});
				if (stripePriceId) await deps.gateway.archivePrice(stripePriceId);
				stripePriceId = newPriceId;
				priceChanged = true;
			}
		}

		const [updated] = await deps.db
			.update(products)
			.set({ stripeProductId, stripePriceId, updatedAt: new Date() })
			.where(eq(products.id, productId))
			.returning();
		return { ok: true, product: updated, priceChanged };
	} catch (err) {
		return { ok: false, error: 'gateway', detail: err instanceof Error ? err.message : String(err) };
	}
}
