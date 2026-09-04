import { describe, expect, it } from 'vitest';
import {
	buildBuyerCompanyMetadata,
	parseBuyerCompanyForm,
	parseBuyerCompanyMetadata
} from './checkout.ts';

// The B2B capture on the cart page (FIX-12): a company address so the
// invoice names the COMPANY's seat, not the parcel address (audit
// 2026-09-03 P1 "B2B invoices carry the parcel address"), the CUI checked
// by checksum, the county as an ISO 3166-2:RO code, and București buyers
// stating their sector — all before Stripe is ever called.

const FULL = {
	name: 'Client SRL',
	cui: 'ro999885',
	regCom: 'J40/9999/2020',
	street: 'Bd. Unirii 5',
	city: 'Sector 4',
	county: 'RO-B',
	postalCode: '040001'
};

describe('parseBuyerCompanyForm', () => {
	it('all empty → a consumer sale (null)', () => {
		expect(
			parseBuyerCompanyForm({
				name: '',
				cui: ' ',
				regCom: '',
				street: '',
				city: '',
				county: '',
				postalCode: ''
			})
		).toEqual({ ok: true, value: null });
	});

	it('accepts a complete company, uppercasing the CUI and normalizing the county to its code', () => {
		expect(parseBuyerCompanyForm(FULL)).toEqual({
			ok: true,
			value: {
				name: 'Client SRL',
				cui: 'RO999885',
				regCom: 'J40/9999/2020',
				address: { street: 'Bd. Unirii 5', city: 'Sector 4', county: 'RO-B', postalCode: '040001' }
			}
		});
		// A county typed as a name is mapped to its code.
		const named = parseBuyerCompanyForm({
			...FULL,
			city: 'Cluj-Napoca',
			county: 'Județul Cluj',
			postalCode: '400001'
		});
		expect(named.ok && named.value?.address).toEqual({
			street: 'Bd. Unirii 5',
			city: 'Cluj-Napoca',
			county: 'RO-CJ',
			postalCode: '400001'
		});
	});

	it('a name alone is a company without an address (the parcel address is used)', () => {
		expect(
			parseBuyerCompanyForm({
				...FULL,
				cui: '',
				regCom: '',
				street: '',
				city: '',
				county: '',
				postalCode: ''
			})
		).toEqual({ ok: true, value: { name: 'Client SRL' } });
	});

	it('refuses a CUI that fails the checksum, and a CUI without a name', () => {
		expect(parseBuyerCompanyForm({ ...FULL, cui: 'RO999888' })).toEqual({
			ok: false,
			error: 'company-cui'
		});
		expect(parseBuyerCompanyForm({ ...FULL, cui: 'not-a-cui' })).toEqual({
			ok: false,
			error: 'company-cui'
		});
		expect(parseBuyerCompanyForm({ ...FULL, name: '' })).toEqual({
			ok: false,
			error: 'company-name'
		});
	});

	it('an address is all-or-nothing; the county must be a RO county; București needs a sector', () => {
		expect(parseBuyerCompanyForm({ ...FULL, postalCode: '' })).toEqual({
			ok: false,
			error: 'company-address'
		});
		expect(parseBuyerCompanyForm({ ...FULL, county: 'Transilvania' })).toEqual({
			ok: false,
			error: 'company-county'
		});
		expect(parseBuyerCompanyForm({ ...FULL, city: 'București' })).toEqual({
			ok: false,
			error: 'company-sector'
		});
		// A sector in the street text satisfies the rule too.
		const inStreet = parseBuyerCompanyForm({
			...FULL,
			city: 'București',
			street: 'Bd. Unirii 5, sector 4'
		});
		expect(inStreet.ok).toBe(true);
	});
});

describe('buyer company metadata', () => {
	it('round-trips the company with its address through Stripe metadata', () => {
		const parsed = parseBuyerCompanyForm(FULL);
		if (!parsed.ok || !parsed.value) throw new Error('fixture must parse');
		const encoded = buildBuyerCompanyMetadata(parsed.value);
		expect(parseBuyerCompanyMetadata(encoded)).toEqual(parsed.value);
		expect(parseBuyerCompanyMetadata(buildBuyerCompanyMetadata({ name: 'Doar Nume SRL' }))).toEqual(
			{
				name: 'Doar Nume SRL'
			}
		);
	});

	it('stays inside the 500-char Stripe metadata value with every field at its cap', () => {
		const parsed = parseBuyerCompanyForm({
			name: 'N'.repeat(200),
			cui: 'RO999885',
			regCom: 'J'.repeat(200),
			street: 'S'.repeat(200),
			city: 'C'.repeat(200),
			county: 'RO-CJ',
			postalCode: '4'.repeat(40)
		});
		if (!parsed.ok || !parsed.value) throw new Error('fixture must parse');
		expect(buildBuyerCompanyMetadata(parsed.value).length).toBeLessThanOrEqual(500);
	});

	it('drops a malformed address but keeps the company; garbage is null', () => {
		expect(
			parseBuyerCompanyMetadata(
				JSON.stringify({ n: 'X SRL', c: 'RO999885', a: { s: 'only street' } })
			)
		).toEqual({ name: 'X SRL', cui: 'RO999885' });
		expect(parseBuyerCompanyMetadata('garbage')).toBeNull();
		expect(parseBuyerCompanyMetadata(JSON.stringify({ c: 'RO999885' }))).toBeNull();
	});
});
