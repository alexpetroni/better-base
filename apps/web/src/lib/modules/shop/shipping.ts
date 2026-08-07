import type { SiteSettings } from '../settings/registry.ts';

/**
 * Shipping options as DATA: everything here derives from `shop.*` site
 * settings, so better-sleep and better-life price delivery independently and
 * an operator edit takes effect on the next request without a code change.
 *
 * Two slots are offered:
 * - `standard` — always available; its price drops to 0 once the goods total
 *   reaches `shop.freeShippingThresholdBani` (threshold 0 = never free);
 * - `express` — offered only while `shop.shippingExpressName` is non-empty;
 *   deliberately NOT affected by the free threshold (it stays a paid upgrade).
 *
 * The customer picks the option in the cart (no-JS radio); the selected option
 * is passed to Stripe Checkout as its single `shipping_options` entry, so the
 * amount Stripe charges is fixed at session creation and equals goods total +
 * the option's price. All amounts are integer bani.
 */

export const SHIPPING_OPTION_IDS = ['standard', 'express'] as const;
export type ShippingOptionId = (typeof SHIPPING_OPTION_IDS)[number];

export interface ShippingOption {
	id: ShippingOptionId;
	name: string;
	/** What this option costs for THIS cart, integer bani (0 = free). */
	priceCents: number;
	/** Free-text delivery estimate shown to the customer ('' = none). */
	etaText: string;
	/** True when the free-shipping threshold zeroed the price. */
	freeOverThreshold: boolean;
}

/** The registry keys shipping derives from — callers may pass a narrow pick. */
export type ShippingSettings = Pick<
	SiteSettings,
	| 'shop.freeShippingThresholdBani'
	| 'shop.shippingStandardName'
	| 'shop.shippingStandardPriceBani'
	| 'shop.shippingStandardEta'
	| 'shop.shippingExpressName'
	| 'shop.shippingExpressPriceBani'
	| 'shop.shippingExpressEta'
>;

/** The options offered for a cart with the given goods total. */
export function shippingOptionsForCart(
	settings: ShippingSettings,
	goodsTotalCents: number
): ShippingOption[] {
	const threshold = settings['shop.freeShippingThresholdBani'];
	const freeStandard = threshold > 0 && goodsTotalCents >= threshold;
	const options: ShippingOption[] = [
		{
			id: 'standard',
			name: settings['shop.shippingStandardName'].trim() || 'Curier standard',
			priceCents: freeStandard ? 0 : settings['shop.shippingStandardPriceBani'],
			etaText: settings['shop.shippingStandardEta'].trim(),
			freeOverThreshold: freeStandard
		}
	];
	const expressName = settings['shop.shippingExpressName'].trim();
	if (expressName) {
		options.push({
			id: 'express',
			name: expressName,
			priceCents: settings['shop.shippingExpressPriceBani'],
			etaText: settings['shop.shippingExpressEta'].trim(),
			freeOverThreshold: false
		});
	}
	return options;
}

export function findShippingOption(
	options: ShippingOption[],
	id: string
): ShippingOption | undefined {
	return options.find((option) => option.id === id);
}

/** `Curier standard (1-3 zile lucrătoare)` — what Stripe Checkout displays. */
export function shippingDisplayName(option: Pick<ShippingOption, 'name' | 'etaText'>): string {
	return option.etaText ? `${option.name} (${option.etaText})` : option.name;
}

export const SHIPPING_METADATA_KEY = 'ship';

/**
 * Compact session-metadata snapshot of the chosen option, `{i, n, p}` like the
 * cart snapshot: the webhook's fallback for the shipping amount (Stripe's
 * `shipping_cost.amount_total` is authoritative when present) and the source
 * of the option name stored on the order and printed on the invoice line.
 */
export function buildShippingMetadata(option: ShippingOption): string {
	return JSON.stringify({ i: option.id, n: option.name, p: option.priceCents });
}

export interface ShippingMetadata {
	id: string;
	name: string;
	priceCents: number;
}

/** Parse it back from the webhook's session; anything malformed → null. */
export function parseShippingMetadata(value: string | undefined): ShippingMetadata | null {
	if (!value) return null;
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null) return null;
	const { i, n, p } = data as { i?: unknown; n?: unknown; p?: unknown };
	if (typeof i !== 'string' || typeof n !== 'string' || !n) return null;
	if (!Number.isInteger(p) || (p as number) < 0) return null;
	return { id: i, name: n, priceCents: p as number };
}
