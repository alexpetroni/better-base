import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { CUI_PATTERN } from '../../util/cui.ts';
import type { SiteSettings } from '../settings/registry.ts';
import { cartTotalCents, type CartItem } from './cart.ts';
import type { StripeGateway } from './gateway.ts';
import { productPillars, products, type BuyerCompany, type ProductRow } from './schema.ts';
import { isOutOfStock } from './service.ts';
import {
	buildShippingMetadata,
	findShippingOption,
	SHIPPING_METADATA_KEY,
	shippingDisplayName,
	shippingOptionsForCart,
	type ShippingSettings
} from './shipping.ts';

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

export const BUYER_COMPANY_METADATA_KEY = 'company';

/** Stripe metadata values are capped at 500 chars; keep each field well under. */
const COMPANY_FIELD_MAX = 120;

export type BuyerCompanyParse =
	{ ok: true; value: BuyerCompany | null } | { ok: false; error: 'company-name' | 'company-cui' };

/**
 * Validate the cart page's optional B2B fields. All empty → no company (null).
 * A CUI or Reg. Com. without a company name is rejected (an invoice cannot
 * name a company it does not know), as is a CUI that is not shaped like one.
 */
export function parseBuyerCompanyForm(input: {
	name: string;
	cui: string;
	regCom: string;
}): BuyerCompanyParse {
	const name = input.name.trim().slice(0, COMPANY_FIELD_MAX);
	const cui = input.cui.trim().slice(0, COMPANY_FIELD_MAX);
	const regCom = input.regCom.trim().slice(0, COMPANY_FIELD_MAX);
	if (!name && !cui && !regCom) return { ok: true, value: null };
	if (!name) return { ok: false, error: 'company-name' };
	if (cui && !CUI_PATTERN.test(cui)) return { ok: false, error: 'company-cui' };
	return {
		ok: true,
		value: { name, ...(cui ? { cui } : {}), ...(regCom ? { regCom } : {}) }
	};
}

/** Compact company snapshot for session metadata: `{n, c, r}`. */
export function buildBuyerCompanyMetadata(company: BuyerCompany): string {
	return JSON.stringify({ n: company.name, c: company.cui ?? '', r: company.regCom ?? '' });
}

/** Parse it back from the webhook's session; anything malformed → null. */
export function parseBuyerCompanyMetadata(value: string | undefined): BuyerCompany | null {
	if (!value) return null;
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null) return null;
	const { n, c, r } = data as { n?: unknown; c?: unknown; r?: unknown };
	if (typeof n !== 'string' || !n) return null;
	return {
		name: n,
		...(typeof c === 'string' && c ? { cui: c } : {}),
		...(typeof r === 'string' && r ? { regCom: r } : {})
	};
}

export interface CartLine {
	product: ProductRow;
	qty: number;
	/** qty × unit price, integer cents. */
	lineTotalCents: number;
	/**
	 * False when the product went inactive, out of stock, or the line asks
	 * for more units than are in stock since it was added.
	 */
	available: boolean;
	/** Units purchasable right now (the tracked stock); null = untracked, no cap. */
	maxQty: number | null;
}

export interface CartDetails {
	lines: CartLine[];
	totalCents: number;
	currency: string;
}

/**
 * Join cookie items against the catalog. Lines whose product disappeared are
 * dropped; lines that became unavailable (inactive, untagged for this site,
 * out of stock, or asking for more than the stock) are kept but flagged, with
 * `maxQty`, so the cart page can say why and cap the input.
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
		const maxQty = product.stock;
		const inStock = !isOutOfStock(product) && (maxQty === null || item.qty <= maxQty);
		lines.push({
			product,
			qty: item.qty,
			lineTotalCents: product.priceCents * item.qty,
			available: product.status === 'active' && tagged && inStock,
			maxQty
		});
	}
	return {
		lines,
		totalCents: cartTotalCents(
			lines
				.filter((l) => l.available)
				.map((l) => ({ priceCents: l.product.priceCents, qty: l.qty }))
		),
		currency: lines[0]?.product.currency ?? 'ron'
	};
}

/** The registry key that decides which Stripe payment methods a session offers. */
export type PaymentSettings = Pick<SiteSettings, 'shop.allowAllPaymentMethods'>;

/**
 * Card-only unless the operator opened all methods (undefined = Stripe's
 * dashboard configuration decides). Absent settings mean the safe default.
 */
export function paymentMethodTypesFor(settings?: PaymentSettings): string[] | undefined {
	return settings?.['shop.allowAllPaymentMethods'] ? undefined : ['card'];
}

export type CheckoutOutcome =
	| { ok: true; sessionId: string; url: string }
	| {
			ok: false;
			error: 'empty-cart' | 'unavailable' | 'invalid-shipping' | 'gateway';
			detail?: string;
	  };

export async function createCheckoutFromCart(
	deps: CheckoutDeps,
	input: {
		items: CartItem[];
		sitePillarSlugs: string[];
		/** The `shop.*` settings the shipping options derive from. */
		shippingSettings: ShippingSettings;
		/** Option id chosen in the cart; validated against the offered options. */
		shippingOptionId: string;
		buyerCompany?: BuyerCompany | null;
		/** `shop.allowAllPaymentMethods`; omitted = card-only. */
		paymentSettings?: PaymentSettings;
	}
): Promise<CheckoutOutcome> {
	const details = await loadCartDetails(deps, input.items, input.sitePillarSlugs);
	if (details.lines.length === 0) return { ok: false, error: 'empty-cart' };

	const unavailable = details.lines.filter((l) => !l.available);
	if (unavailable.length > 0) {
		// A line over the stock names the count still available; the cart page
		// renders this list verbatim, so it stays language-neutral.
		return {
			ok: false,
			error: 'unavailable',
			detail: unavailable
				.map((l) =>
					l.maxQty !== null && l.maxQty > 0 ? `${l.product.name} (max ${l.maxQty})` : l.product.name
				)
				.join(', ')
		};
	}

	// Priced HERE, from settings and this cart's goods total — never from the
	// client. An id that is not currently offered (e.g. express got disabled
	// while the cart page was open) is refused, not silently substituted.
	const options = shippingOptionsForCart(input.shippingSettings, details.totalCents);
	const shipping = findShippingOption(options, input.shippingOptionId);
	if (!shipping) return { ok: false, error: 'invalid-shipping', detail: input.shippingOptionId };

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
			shippingOption: {
				displayName: shippingDisplayName(shipping),
				amountCents: shipping.priceCents,
				currency: details.currency
			},
			paymentMethodTypes: paymentMethodTypesFor(input.paymentSettings),
			metadata: {
				[CART_METADATA_KEY]: buildCartMetadata(
					details.lines.map((l) => ({
						productId: l.product.id,
						qty: l.qty,
						priceCents: l.product.priceCents
					}))
				),
				[SHIPPING_METADATA_KEY]: buildShippingMetadata(shipping),
				...(input.buyerCompany
					? { [BUYER_COMPANY_METADATA_KEY]: buildBuyerCompanyMetadata(input.buyerCompany) }
					: {})
			}
		});
		return { ok: true, sessionId: session.id, url: session.url };
	} catch (err) {
		return {
			ok: false,
			error: 'gateway',
			detail: err instanceof Error ? err.message : String(err)
		};
	}
}
