import { describe, expect, it } from 'vitest';
import { renderEmailTemplate } from '../email/templates.ts';
import { settingsDefaults } from '../settings/registry.ts';
import {
	buildShippingMetadata,
	findShippingOption,
	parseShippingMetadata,
	shippingDisplayName,
	shippingOptionsForCart,
	type ShippingSettings
} from './shipping.ts';

// Pure shipping-option selection: everything derives from settings, so a
// configuration edit changes prices with NO code change (the launch rule).

function settings(overrides: Partial<ShippingSettings> = {}): ShippingSettings {
	return {
		...settingsDefaults(),
		'shop.shippingStandardName': 'Curier standard',
		'shop.shippingStandardPriceBani': 1990,
		'shop.shippingStandardEta': '1-3 zile lucrătoare',
		...overrides
	};
}

describe('shippingOptionsForCart', () => {
	it('offers the standard option priced from settings, under the free threshold', () => {
		const options = shippingOptionsForCart(
			settings({ 'shop.freeShippingThresholdBani': 20000 }),
			15000
		);
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			id: 'standard',
			name: 'Curier standard',
			priceCents: 1990,
			etaText: '1-3 zile lucrătoare',
			freeOverThreshold: false
		});
	});

	it('zeroes the standard price at and over the free threshold', () => {
		const cfg = settings({ 'shop.freeShippingThresholdBani': 20000 });
		expect(shippingOptionsForCart(cfg, 20000)[0]).toMatchObject({
			priceCents: 0,
			freeOverThreshold: true
		});
		expect(shippingOptionsForCart(cfg, 99999)[0].priceCents).toBe(0);
		// Threshold 0 = free shipping disabled, whatever the goods total.
		expect(shippingOptionsForCart(settings(), 999999)[0].priceCents).toBe(1990);
	});

	it('offers express only while its name is set, and never applies the threshold to it', () => {
		expect(shippingOptionsForCart(settings(), 1000)).toHaveLength(1);

		const withExpress = settings({
			'shop.freeShippingThresholdBani': 20000,
			'shop.shippingExpressName': 'Curier rapid',
			'shop.shippingExpressPriceBani': 3490,
			'shop.shippingExpressEta': '24h'
		});
		const options = shippingOptionsForCart(withExpress, 50000);
		expect(options).toHaveLength(2);
		// Standard went free over the threshold; express stays a paid upgrade.
		expect(findShippingOption(options, 'standard')?.priceCents).toBe(0);
		expect(findShippingOption(options, 'express')).toMatchObject({
			name: 'Curier rapid',
			priceCents: 3490,
			etaText: '24h',
			freeOverThreshold: false
		});
	});

	it('a settings edit changes the offer with no code change', () => {
		const before = shippingOptionsForCart(settings(), 1000);
		const after = shippingOptionsForCart(
			settings({ 'shop.shippingStandardPriceBani': 2590, 'shop.shippingStandardName': 'DPD' }),
			1000
		);
		expect(before[0].priceCents).toBe(1990);
		expect(after[0]).toMatchObject({ name: 'DPD', priceCents: 2590 });
	});

	it('findShippingOption refuses ids that are not currently offered', () => {
		const options = shippingOptionsForCart(settings(), 1000);
		expect(findShippingOption(options, 'express')).toBeUndefined();
		expect(findShippingOption(options, 'nope')).toBeUndefined();
	});
});

describe('shippingDisplayName', () => {
	it('appends the ETA when present', () => {
		expect(shippingDisplayName({ name: 'Curier', etaText: '1-3 zile' })).toBe('Curier (1-3 zile)');
		expect(shippingDisplayName({ name: 'Curier', etaText: '' })).toBe('Curier');
	});
});

describe('shipping metadata snapshot', () => {
	it('round-trips through the session metadata', () => {
		const [option] = shippingOptionsForCart(settings(), 1000);
		const parsed = parseShippingMetadata(buildShippingMetadata(option));
		expect(parsed).toEqual({ id: 'standard', name: 'Curier standard', priceCents: 1990 });
	});

	it('degrades malformed values to null instead of throwing', () => {
		expect(parseShippingMetadata(undefined)).toBeNull();
		expect(parseShippingMetadata('')).toBeNull();
		expect(parseShippingMetadata('not json')).toBeNull();
		expect(parseShippingMetadata('[]')).toBeNull();
		expect(parseShippingMetadata('{"i":"standard","n":"","p":100}')).toBeNull();
		expect(parseShippingMetadata('{"i":"standard","n":"Curier","p":-1}')).toBeNull();
		expect(parseShippingMetadata('{"i":"standard","n":"Curier","p":1.5}')).toBeNull();
	});
});

describe('shipping-notification template', () => {
	it('renders the AWB, tracking link and order link in both bodies', () => {
		const rendered = renderEmailTemplate('shipping-notification', {
			siteName: 'Better Sleep',
			orderId: 'order-1',
			awb: 'MOCKAWB000001',
			trackingUrl: 'https://tracking.courier.example/awb/MOCKAWB000001',
			shippingName: 'Curier standard',
			orderUrl: 'https://bettersleep.ro/cos/succes?session_id=cs_1'
		});
		expect(rendered.subject).toContain('expediată');
		for (const body of [rendered.html, rendered.text]) {
			expect(body).toContain('MOCKAWB000001');
			expect(body).toContain('https://tracking.courier.example/awb/MOCKAWB000001');
			expect(body).toContain('Curier standard');
			expect(body).toContain('https://bettersleep.ro/cos/succes?session_id=cs_1');
		}
	});
});
