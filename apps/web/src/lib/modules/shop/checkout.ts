import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { cartTotalCents, type CartItem } from './cart.ts';
import type { StripeGateway } from './gateway.ts';
import { productPillars, products, type ProductRow } from './schema.ts';
import { isOutOfStock } from './service.ts';

/**
 * Checkout-session creation from the cookie cart. Prices come from the
 * database at this moment (never from the client); the exact snapshot the
 * customer paid for travels to the webhook in the session's `cart` metadata.
 */

export interface CheckoutDeps {
	db: Db;
	gateway: StripeGateway;
	/** Public origin for success/cancel URLs (PUBLIC_SITE_URL). */
	baseUrl: string;
}

/** What the webhook needs to rebuild order items: id, qty, unit price paid. */
export interface CartMetadataItem {
	i: string;
	q: number;
	p: number;
}

export const CART_METADATA_KEY = 'cart';

export function buildCartMetadata(
	lines: Array<{ productId: string; qty: number; priceCents: number }>
): string {
	return JSON.stringify(
		lines.map((l): CartMetadataItem => ({ i: l.productId, q: l.qty, p: l.priceCents }))
	);
}

/** Parse the metadata back; anything malformed degrades to an empty list. */
export function parseCartMetadata(value: string | undefined): CartMetadataItem[] {
	if (!value) return [];
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	return data.filter(
		(entry): entry is CartMetadataItem =>
			typeof entry === 'object' &&
			entry !== null &&
			typeof (entry as CartMetadataItem).i === 'string' &&
			Number.isInteger((entry as CartMetadataItem).q) &&
			(entry as CartMetadataItem).q > 0 &&
			Number.isInteger((entry as CartMetadataItem).p) &&
			(entry as CartMetadataItem).p >= 0
	);
}

export interface CartLine {
	product: ProductRow;
	qty: number;
	/** qty × unit price, integer cents. */
	lineTotalCents: number;
	/** False when the product went inactive/out of stock since it was added. */
	available: boolean;
}

export interface CartDetails {
	lines: CartLine[];
	totalCents: number;
	currency: string;
}

/**
 * Join cookie items against the catalog. Lines whose product disappeared are
 * dropped; lines that became unavailable (inactive, untagged for this site,
 * out of stock) are kept but flagged so the cart page can say why.
 */
export async function loadCartDetails(
	deps: Pick<CheckoutDeps, 'db'>,
	items: CartItem[],
	sitePillarSlugs: string[]
): Promise<CartDetails> {
	if (items.length === 0) return { lines: [], totalCents: 0, currency: 'ron' };

	const ids = items.map((i) => i.productId);
	const rows = await deps.db.select().from(products).where(inArray(products.id, ids));
	const tagRows = await deps.db
		.select({ productId: productPillars.productId, slug: pillars.slug })
		.from(productPillars)
		.innerJoin(pillars, eq(productPillars.pillarId, pillars.id))
		.where(inArray(productPillars.productId, ids));
	const byId = new Map(rows.map((r) => [r.id, r]));

	const lines: CartLine[] = [];
	for (const item of items) {
		const product = byId.get(item.productId);
		if (!product) continue;
		const tagged = tagRows.some(
			(t) => t.productId === product.id && sitePillarSlugs.includes(t.slug)
		);
		lines.push({
			product,
			qty: item.qty,
			lineTotalCents: product.priceCents * item.qty,
			available: product.status === 'active' && tagged && !isOutOfStock(product)
		});
	}
	return {
		lines,
		totalCents: cartTotalCents(
			lines.filter((l) => l.available).map((l) => ({ priceCents: l.product.priceCents, qty: l.qty }))
		),
		currency: lines[0]?.product.currency ?? 'ron'
	};
}

export type CheckoutOutcome =
	| { ok: true; sessionId: string; url: string }
	| { ok: false; error: 'empty-cart' | 'unavailable' | 'gateway'; detail?: string };

export async function createCheckoutFromCart(
	deps: CheckoutDeps,
	input: { items: CartItem[]; sitePillarSlugs: string[] }
): Promise<CheckoutOutcome> {
	const details = await loadCartDetails(deps, input.items, input.sitePillarSlugs);
	if (details.lines.length === 0) return { ok: false, error: 'empty-cart' };

	const unavailable = details.lines.filter((l) => !l.available);
	if (unavailable.length > 0) {
		return {
			ok: false,
			error: 'unavailable',
			detail: unavailable.map((l) => l.product.name).join(', ')
		};
	}

	try {
		const session = await deps.gateway.createCheckoutSession({
			lineItems: details.lines.map((l) => ({
				name: l.product.name,
				unitAmountCents: l.product.priceCents,
				currency: l.product.currency,
				qty: l.qty
			})),
			// Stripe substitutes the literal {CHECKOUT_SESSION_ID} placeholder.
			successUrl: `${deps.baseUrl}/cos/succes?session_id={CHECKOUT_SESSION_ID}`,
			cancelUrl: `${deps.baseUrl}/cos`,
			shippingCountries: ['RO'],
			metadata: {
				[CART_METADATA_KEY]: buildCartMetadata(
					details.lines.map((l) => ({
						productId: l.product.id,
						qty: l.qty,
						priceCents: l.product.priceCents
					}))
				)
			}
		});
		return { ok: true, sessionId: session.id, url: session.url };
	} catch (err) {
		return { ok: false, error: 'gateway', detail: err instanceof Error ? err.message : String(err) };
	}
}
