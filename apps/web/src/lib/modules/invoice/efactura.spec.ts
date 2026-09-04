import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { InvoiceLineRow, InvoiceRow } from './schema.ts';
import type { InvoiceDocumentModel } from './model.ts';
import { bpToPercent, renderEFacturaXml, taxGroups, vatCategoryFor } from './efactura.ts';
import { validateEFacturaXml } from './efactura-validate.ts';
import { noopEFacturaSubmitter, selectEFacturaSubmitter } from './efactura-submitter.ts';
import { computeLineAmounts, partialStornoLineAmounts, sumAmounts } from './vat.ts';

// The XML and the PDF render from ONE snapshot; this suite proves the XML
// side never disagrees with it: structural + arithmetic validity for a range
// of generated invoices (property-style over odd-bani carts), the neplătitor
// (category O) rules, the storno shape, and that the validator actually
// bites on tampered documents.

function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
	return {
		id: 'inv-1',
		kind: 'invoice',
		series: 'BSL',
		number: 42,
		displayNumber: 'BSL-0042',
		orderId: 'order-1',
		stornoOfInvoiceId: null,
		issuedAt: new Date('2026-08-07T10:15:00Z'),
		dueAt: new Date('2026-08-07T10:15:00Z'),
		currency: 'ron',
		issuerName: 'Șosete Țesute SRL',
		issuerCui: 'RO12345676',
		issuerVatRegistered: true,
		issuerRegCom: 'J40/1234/2025',
		issuerAddress: 'Str. Somnului 10, București',
		issuerPlace: 'București',
		issuerEmail: 'contact@better-sleep.ro',
		issuerPhone: '+40 700 000 000',
		issuerIban: 'RO49AAAA1B31007593840000',
		issuerBank: 'Banca Transilvania',
		// Structured seller address (FIX-12): a București seat → SECTORn city.
		issuerStreet: 'Str. Somnului 10',
		issuerCity: 'Sector 3',
		issuerCounty: 'RO-B',
		issuerPostalCode: '030167',
		issuerCountry: 'RO',
		issuerCapital: '200 lei',
		buyerName: 'Ștefan Țăranu',
		buyerEmail: 'stefan@example.ro',
		buyerAddress: 'Str. Înțelepciunii 3\n400001 Cluj-Napoca\nCluj',
		buyerStreet: 'Str. Înțelepciunii 3',
		buyerCity: 'Cluj-Napoca',
		buyerCounty: 'RO-CJ',
		buyerPostalCode: '400001',
		buyerCountry: 'RO',
		buyerCompanyName: null,
		buyerCompanyCui: null,
		buyerCompanyRegCom: null,
		netTotalCents: 4124,
		vatTotalCents: 866,
		grossTotalCents: 4990,
		mentions: '',
		vatExemptionReason: '',
		orderReference: 'order-1',
		paymentReference: 'pi_test_order_1',
		paymentMethod: 'card',
		paidAt: new Date('2026-08-07T10:15:00Z'),
		...overrides
	};
}

function fixture(name: string): string {
	return readFileSync(
		path.resolve(import.meta.dirname, '../../../../tests/fixtures/efactura', name),
		'utf8'
	);
}

/** The customer party's PostalAddress block of a rendered document. */
function customerAddress(xml: string): string {
	return /<cac:AccountingCustomerParty>.*?<cac:PostalAddress>(.*?)<\/cac:PostalAddress>/s.exec(
		xml
	)![1];
}
function supplierAddress(xml: string): string {
	return /<cac:AccountingSupplierParty>.*?<cac:PostalAddress>(.*?)<\/cac:PostalAddress>/s.exec(
		xml
	)![1];
}
function customerParty(xml: string): string {
	return /<cac:AccountingCustomerParty>(.*?)<\/cac:AccountingCustomerParty>/s.exec(xml)![1];
}

/** Build a consistent model through the REAL VAT math from cart-style items. */
function modelFromItems(
	items: Array<{ name: string; qty: number; priceCents: number }>,
	opts: { vatRateBp?: number; vatRegistered?: boolean } = {}
): InvoiceDocumentModel {
	const vatRegistered = opts.vatRegistered ?? true;
	const rate = vatRegistered ? (opts.vatRateBp ?? 2100) : 0;
	const amounts = items.map((item) =>
		computeLineAmounts({ qty: item.qty, unitPriceCents: item.priceCents, vatRateBp: rate })
	);
	const totals = sumAmounts(amounts);
	const invoice = makeInvoice({
		issuerVatRegistered: vatRegistered,
		netTotalCents: totals.netCents,
		vatTotalCents: totals.vatCents,
		grossTotalCents: totals.grossCents,
		mentions: vatRegistered ? '' : 'Neplătitor de TVA'
	});
	const lines: InvoiceLineRow[] = items.map((item, i) => ({
		id: `line-${i + 1}`,
		invoiceId: invoice.id,
		position: i + 1,
		description: item.name,
		qty: item.qty,
		unitPriceCents: item.priceCents,
		vatRateBp: rate,
		...amounts[i]
	}));
	return { invoice, lines, stornoOf: null };
}

describe('renderEFacturaXml', () => {
	it('emits a valid CIUS-RO document that agrees with the snapshot', () => {
		const model = modelFromItems([
			{ name: 'Pernă cu spumă cu memorie', qty: 1, priceCents: 8990 },
			{ name: 'Ceai de mușețel & lavandă <bio>', qty: 3, priceCents: 1150 }
		]);
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		// Deterministic output.
		expect(renderEFacturaXml(model)).toBe(xml);
		// Diacritics + escaping survive.
		expect(xml).toContain('Șosete Țesute SRL');
		expect(xml).toContain('Ceai de mușețel &amp; lavandă &lt;bio&gt;');
		expect(xml).toContain('<cbc:ID>BSL-0042</cbc:ID>');
		expect(xml).toContain('<cbc:IssueDate>2026-08-07</cbc:IssueDate>');
		expect(xml).toContain('currencyID="RON"');
	});

	it('property: XML totals equal the record over many odd-bani carts', () => {
		const carts = [
			[{ name: 'A', qty: 1, priceCents: 1 }],
			[{ name: 'A', qty: 7, priceCents: 333 }],
			[
				{ name: 'A', qty: 2, priceCents: 4999 },
				{ name: 'B', qty: 5, priceCents: 101 }
			],
			[
				{ name: 'A', qty: 1, priceCents: 123457 },
				{ name: 'B', qty: 3, priceCents: 89 },
				{ name: 'C', qty: 11, priceCents: 777 }
			],
			[{ name: 'A', qty: 100, priceCents: 12345 }]
		];
		const rates = [2100, 1900, 900, 500];
		expect.hasAssertions();
		for (const cart of carts) {
			for (const rate of rates) {
				const model = modelFromItems(cart, { vatRateBp: rate });
				const problems = validateEFacturaXml(renderEFacturaXml(model), model);
				expect(problems, `cart ${JSON.stringify(cart)} @ ${rate}bp`).toEqual([]);
			}
		}
	});

	it('renders the neplătitor case as category O with the exemption mention', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 2, priceCents: 4990 }], {
			vatRegistered: false
		});
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).toContain('<cbc:ID>O</cbc:ID>');
		expect(xml).toContain('<cbc:TaxExemptionReason>Neplătitor de TVA</cbc:TaxExemptionReason>');
		// The unregistered issuer carries no VAT identifier and no percent.
		expect(xml).not.toContain('cac:PartyTaxScheme');
		expect(xml).not.toContain('cbc:Percent');
	});

	it('renders a storno as a negative 380 with a BillingReference', () => {
		const base = modelFromItems([{ name: 'Pernă', qty: 2, priceCents: 4990 }]);
		const original = base.invoice;
		const storno: InvoiceDocumentModel = {
			invoice: {
				...original,
				id: 'inv-2',
				kind: 'storno',
				number: 43,
				displayNumber: 'BSL-0043',
				stornoOfInvoiceId: original.id,
				netTotalCents: -original.netTotalCents,
				vatTotalCents: -original.vatTotalCents,
				grossTotalCents: -original.grossTotalCents
			},
			lines: base.lines.map((line) => ({
				...line,
				invoiceId: 'inv-2',
				qty: -line.qty,
				netCents: -line.netCents,
				vatCents: -line.vatCents,
				grossCents: -line.grossCents
			})),
			stornoOf: { displayNumber: original.displayNumber, issuedAt: original.issuedAt }
		};
		const xml = renderEFacturaXml(storno);
		expect(validateEFacturaXml(xml, storno)).toEqual([]);
		expect(xml).toContain('<cac:BillingReference>');
		expect(xml).toContain('<cbc:ID>BSL-0042</cbc:ID>');
		expect(xml).toContain('<cbc:InvoicedQuantity unitCode="H87">-2</cbc:InvoicedQuantity>');
		expect(xml).toContain('>-82.48<'); // negative net total, dot decimal
	});

	it('renders a PARTIAL storno (one amount line at the original rate) as a valid negative 380', () => {
		// FIX-10: a partial refund of 15,00 lei on a 99,80 lei invoice.
		const base = modelFromItems([{ name: 'Pernă', qty: 2, priceCents: 4990 }]);
		const original = base.invoice;
		const amounts = partialStornoLineAmounts(1500, 2100);
		const storno: InvoiceDocumentModel = {
			invoice: {
				...original,
				id: 'inv-3',
				kind: 'storno',
				number: 44,
				displayNumber: 'BSL-0044',
				stornoOfInvoiceId: original.id,
				netTotalCents: amounts.netCents,
				vatTotalCents: amounts.vatCents,
				grossTotalCents: amounts.grossCents
			},
			lines: [
				{
					id: 'line-partial',
					invoiceId: 'inv-3',
					position: 1,
					description: 'Storno parțial — factura BSL-0042',
					qty: -1,
					unitPriceCents: 1500,
					vatRateBp: 2100,
					...amounts
				}
			],
			stornoOf: { displayNumber: original.displayNumber, issuedAt: original.issuedAt }
		};
		const xml = renderEFacturaXml(storno);
		expect(validateEFacturaXml(xml, storno)).toEqual([]);
		expect(xml).toContain('<cac:BillingReference>');
		expect(xml).toContain('<cbc:InvoicedQuantity unitCode="H87">-1</cbc:InvoicedQuantity>');
		expect(xml).toContain('>-15.00<'); // gross, dot decimal
		expect(xml).toContain('>-2.60<'); // the VAT contained in 15,00 at 21 %
	});

	it('the validator bites: tampered totals and wrong snapshots are reported', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		const xml = renderEFacturaXml(model);

		const tamperedTotal = xml.replace(
			/<cbc:PayableAmount currencyID="RON">[^<]+/,
			'<cbc:PayableAmount currencyID="RON">99.99'
		);
		expect(validateEFacturaXml(tamperedTotal, model)).not.toEqual([]);

		const wrongSnapshot = {
			...model,
			invoice: { ...model.invoice, grossTotalCents: model.invoice.grossTotalCents + 1 }
		};
		expect(validateEFacturaXml(xml, wrongSnapshot)).toContain('gross total ≠ snapshot');

		expect(validateEFacturaXml('<Invoice>not even close')).not.toEqual([]);
	});
});

describe('CIUS-RO addresses (FIX-12)', () => {
	it('emits CountrySubentity + PostalZone for both parties; a Cluj buyer keeps its city name', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		const buyer = customerAddress(xml);
		expect(buyer).toContain('<cbc:StreetName>Str. Înțelepciunii 3</cbc:StreetName>');
		expect(buyer).toContain('<cbc:CityName>Cluj-Napoca</cbc:CityName>');
		expect(buyer).toContain('<cbc:PostalZone>400001</cbc:PostalZone>');
		expect(buyer).toContain('<cbc:CountrySubentity>RO-CJ</cbc:CountrySubentity>');
		expect(buyer).toContain('<cbc:IdentificationCode>RO</cbc:IdentificationCode>');
		// UBL element order inside PostalAddress: Street, City, PostalZone, CountrySubentity, Country.
		expect(buyer).toMatch(
			/StreetName>.*<cbc:CityName>.*<cbc:PostalZone>.*<cbc:CountrySubentity>.*<cac:Country>/s
		);
	});

	it('a București party carries SECTORn as its CityName under RO-B', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		const xml = renderEFacturaXml(model);
		const seller = supplierAddress(xml);
		expect(seller).toContain('<cbc:CityName>SECTOR3</cbc:CityName>');
		expect(seller).toContain('<cbc:CountrySubentity>RO-B</cbc:CountrySubentity>');
		expect(seller).toContain('<cbc:PostalZone>030167</cbc:PostalZone>');
		expect(seller).not.toContain('Sector 3<');

		// The sector may also sit in the street text (Stripe's free-form input).
		const inStreet = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		inStreet.invoice.buyerStreet = 'Bd. Unirii 5, sector 4';
		inStreet.invoice.buyerCity = 'București';
		inStreet.invoice.buyerCounty = 'RO-B';
		inStreet.invoice.buyerPostalCode = '040001';
		const buyerXml = renderEFacturaXml(inStreet);
		expect(validateEFacturaXml(buyerXml, inStreet)).toEqual([]);
		expect(customerAddress(buyerXml)).toContain('<cbc:CityName>SECTOR4</cbc:CityName>');
	});

	it('a B2B buyer with a RO-prefixed CUI carries its VAT id under category S', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		model.invoice.buyerCompanyName = 'Client SRL';
		model.invoice.buyerCompanyCui = 'RO999885';
		model.invoice.buyerCompanyRegCom = 'J12/99/2020';
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		const party = customerParty(xml);
		expect(party).toContain('<cac:PartyTaxScheme><cbc:CompanyID>RO999885</cbc:CompanyID>');
		// The legal identifier (BT-47) sits in PartyLegalEntity next to the name.
		expect(party).toContain(
			'<cac:PartyLegalEntity><cbc:RegistrationName>Client SRL</cbc:RegistrationName><cbc:CompanyID>RO999885</cbc:CompanyID>'
		);
	});

	it('under category O (neplătitor issuer) the buyer VAT id is suppressed too (BR-O-2)', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }], {
			vatRegistered: false
		});
		model.invoice.issuerCui = '12345676';
		model.invoice.buyerCompanyName = 'Client SRL';
		model.invoice.buyerCompanyCui = 'RO999885';
		model.invoice.vatExemptionReason = 'Neplătitor de TVA';
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).not.toContain('cac:PartyTaxScheme');
		// The buyer's legal identifier (BT-47) stays: only the VAT scheme goes.
		expect(customerParty(xml)).toContain('<cbc:CompanyID>RO999885</cbc:CompanyID>');
	});

	it('legacy rows without structured fields still render from the flattened address', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		Object.assign(model.invoice, {
			buyerStreet: '',
			buyerCity: '',
			buyerCounty: '',
			buyerPostalCode: '',
			buyerCountry: ''
		});
		const xml = renderEFacturaXml(model);
		expect(customerAddress(xml)).toContain('<cbc:StreetName>Str. Înțelepciunii 3</cbc:StreetName>');
		// …and the extended validator says exactly what ANAF would miss.
		expect(validateEFacturaXml(xml, model).join('\n')).toMatch(/customer.*CountrySubentity/);
	});

	it('the extended validator bites: missing county, wrong București city, buyer VAT id under O', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);

		const noCounty = xml.replace('<cbc:CountrySubentity>RO-CJ</cbc:CountrySubentity>', '');
		expect(validateEFacturaXml(noCounty, model).join('\n')).toMatch(/customer.*CountrySubentity/);

		const badSector = xml.replace(
			'<cbc:CityName>SECTOR3</cbc:CityName>',
			'<cbc:CityName>București</cbc:CityName>'
		);
		expect(validateEFacturaXml(badSector, model).join('\n')).toMatch(/supplier.*SECTOR/);

		const noPostal = xml.replace('<cbc:PostalZone>400001</cbc:PostalZone>', '');
		expect(validateEFacturaXml(noPostal, model).join('\n')).toMatch(/customer.*PostalZone/);

		const unregistered = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }], {
			vatRegistered: false
		});
		unregistered.invoice.issuerCui = '12345676';
		unregistered.invoice.vatExemptionReason = 'Neplătitor de TVA';
		const oXml = renderEFacturaXml(unregistered);
		const injected = oXml.replace(
			'<cac:PartyLegalEntity><cbc:RegistrationName>Ștefan Țăranu',
			'<cac:PartyTaxScheme><cbc:CompanyID>RO999885</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Ștefan Țăranu'
		);
		expect(injected).not.toBe(oXml);
		expect(validateEFacturaXml(injected, unregistered).join('\n')).toMatch(/BR-O-2/);
	});
});

describe('payment, order reference and the exemption column (FIX-12)', () => {
	it('a card-paid invoice is PREPAID: means code 48, PaymentID, PrepaidAmount = total, PayableAmount 0', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).toContain('<cac:OrderReference><cbc:ID>order-1</cbc:ID></cac:OrderReference>');
		expect(xml).toContain('<cbc:PaymentMeansCode>48</cbc:PaymentMeansCode>');
		expect(xml).toContain('<cbc:PaymentID>pi_test_order_1</cbc:PaymentID>');
		expect(xml).not.toContain('<cbc:PaymentMeansCode>42</cbc:PaymentMeansCode>');
		expect(xml).toContain('<cbc:PrepaidAmount currencyID="RON">49.90</cbc:PrepaidAmount>');
		expect(xml).toContain('<cbc:PayableAmount currencyID="RON">0.00</cbc:PayableAmount>');
		// UBL order: OrderReference precedes the parties; PrepaidAmount precedes PayableAmount.
		expect(xml).toMatch(/<cac:OrderReference>.*<cac:AccountingSupplierParty>/s);
		expect(xml).toMatch(/<cbc:PrepaidAmount.*<cbc:PayableAmount/s);

		// BR-CO-16 is enforced: a payable amount that ignores the prepayment is refused.
		const tampered = xml.replace(
			'<cbc:PayableAmount currencyID="RON">0.00</cbc:PayableAmount>',
			'<cbc:PayableAmount currencyID="RON">49.90</cbc:PayableAmount>'
		);
		expect(validateEFacturaXml(tampered, model).join('\n')).toMatch(/PayableAmount/);
	});

	it('an unpaid document (no paidAt) stays payable, with the IBAN as means 42', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }]);
		model.invoice.paidAt = null;
		model.invoice.paymentMethod = '';
		model.invoice.paymentReference = '';
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).not.toContain('cbc:PrepaidAmount');
		expect(xml).toContain('<cbc:PayableAmount currencyID="RON">49.90</cbc:PayableAmount>');
		expect(xml).toContain('<cbc:PaymentMeansCode>42</cbc:PaymentMeansCode>');
	});

	it('the exemption reason comes from its own column, never from the payment-terms note', () => {
		const model = modelFromItems([{ name: 'Pernă', qty: 1, priceCents: 4990 }], {
			vatRegistered: false
		});
		model.invoice.issuerCui = '12345676';
		// A snapshot whose mentions start with the payment-terms note (the
		// audit's hole): the dedicated column wins.
		model.invoice.mentions = 'Plata s-a efectuat cu cardul.';
		model.invoice.vatExemptionReason = 'Neplătitor de TVA';
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).toContain('<cbc:TaxExemptionReason>Neplătitor de TVA</cbc:TaxExemptionReason>');
		expect(xml).not.toContain('<cbc:TaxExemptionReason>Plata');
		// A pre-FIX-12 row (empty column) still falls back to its first mention line.
		model.invoice.mentions = 'Neplătitor de TVA\nPlata s-a efectuat cu cardul.';
		model.invoice.vatExemptionReason = '';
		expect(renderEFacturaXml(model)).toContain(
			'<cbc:TaxExemptionReason>Neplătitor de TVA</cbc:TaxExemptionReason>'
		);
	});
});

describe('golden fixtures (byte-stable; ANAF validation is a LAUNCH-CHECKLIST step)', () => {
	// The two RO address shapes: a județ buyer and a București-sector B2B
	// buyer. The files are what an operator uploads to ANAF's public validator
	// (README § e-Factura); any renderer change that alters them must be a
	// deliberate re-validation, never a silent drift.
	function goldenCluj(): InvoiceDocumentModel {
		return modelFromItems([
			{ name: 'Pernă cu spumă cu memorie', qty: 1, priceCents: 8990 },
			{ name: 'Ceai de seară cu mușețel', qty: 2, priceCents: 3450 }
		]);
	}
	function goldenBucharestB2b(): InvoiceDocumentModel {
		const model = modelFromItems([{ name: 'Mască de somn premium', qty: 3, priceCents: 8990 }]);
		Object.assign(model.invoice, {
			id: 'inv-2',
			number: 43,
			displayNumber: 'BSL-0043',
			orderId: 'order-2',
			orderReference: 'order-2',
			paymentReference: 'pi_test_order_2',
			buyerName: 'Client Exemplu SRL',
			buyerEmail: 'facturi@client-exemplu.ro',
			buyerAddress: 'Bd. Unirii 5\n040001 Sector 4\nBucurești',
			buyerStreet: 'Bd. Unirii 5',
			buyerCity: 'Sector 4',
			buyerCounty: 'RO-B',
			buyerPostalCode: '040001',
			buyerCompanyName: 'Client Exemplu SRL',
			buyerCompanyCui: 'RO999885',
			buyerCompanyRegCom: 'J40/9999/2020'
		});
		return model;
	}

	it('renders the Cluj B2C invoice byte-for-byte as committed', () => {
		const model = goldenCluj();
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).toBe(fixture('factura-cluj.xml'));
	});

	it('renders the București-sector B2B invoice byte-for-byte as committed', () => {
		const model = goldenBucharestB2b();
		const xml = renderEFacturaXml(model);
		expect(validateEFacturaXml(xml, model)).toEqual([]);
		expect(xml).toBe(fixture('factura-bucuresti-sector-b2b.xml'));
	});
});

describe('tax grouping + helpers', () => {
	it('groups subtotals by category and rate', () => {
		const model = modelFromItems([
			{ name: 'A', qty: 1, priceCents: 4990 },
			{ name: 'B', qty: 2, priceCents: 1000 }
		]);
		const groups = taxGroups(model);
		expect(groups).toHaveLength(1);
		expect(groups[0].taxableCents).toBe(model.invoice.netTotalCents);
		expect(groups[0].taxCents).toBe(model.invoice.vatTotalCents);
	});

	it('maps VAT categories from the issuer state and rate', () => {
		const registered = makeInvoice();
		const unregistered = makeInvoice({ issuerVatRegistered: false });
		const line = { vatRateBp: 2100 } as InvoiceLineRow;
		const zeroLine = { vatRateBp: 0 } as InvoiceLineRow;
		expect(vatCategoryFor(registered, line)).toBe('S');
		expect(vatCategoryFor(registered, zeroLine)).toBe('Z');
		expect(vatCategoryFor(unregistered, zeroLine)).toBe('O');
	});

	it('formats basis points as UBL percents', () => {
		expect(bpToPercent(2100)).toBe('21');
		expect(bpToPercent(1950)).toBe('19.5');
		expect(bpToPercent(525)).toBe('5.25');
	});
});

describe('EFacturaSubmitter seam', () => {
	it('defaults to the explicit no-op and never fakes a submission', async () => {
		const submitter = selectEFacturaSubmitter({});
		expect(submitter).toBe(noopEFacturaSubmitter);
		await expect(
			submitter.submit({ invoiceId: 'inv-1', displayNumber: 'BSL-0042', xml: '<Invoice/>' })
		).resolves.toEqual({ status: 'skipped', reason: 'anaf-not-configured' });
	});

	it('refuses to pretend when ANAF submission is requested but unimplemented', () => {
		expect(() => selectEFacturaSubmitter({ ANAF_EFACTURA_ENABLED: 'true' })).toThrow(
			/qualified certificate/
		);
	});
});
