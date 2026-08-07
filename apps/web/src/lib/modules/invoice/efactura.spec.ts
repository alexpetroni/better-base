import { describe, expect, it } from 'vitest';
import type { InvoiceLineRow, InvoiceRow } from './schema.ts';
import type { InvoiceDocumentModel } from './model.ts';
import { bpToPercent, renderEFacturaXml, taxGroups, vatCategoryFor } from './efactura.ts';
import { validateEFacturaXml } from './efactura-validate.ts';
import { noopEFacturaSubmitter, selectEFacturaSubmitter } from './efactura-submitter.ts';
import { computeLineAmounts, sumAmounts } from './vat.ts';

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
		issuerCui: 'RO12345678',
		issuerVatRegistered: true,
		issuerRegCom: 'J40/1234/2025',
		issuerAddress: 'Str. Somnului 10, București',
		issuerPlace: 'București',
		issuerEmail: 'contact@better-sleep.ro',
		issuerPhone: '+40 700 000 000',
		issuerIban: 'RO49AAAA1B31007593840000',
		issuerBank: 'Banca Transilvania',
		buyerName: 'Ștefan Țăranu',
		buyerEmail: 'stefan@example.ro',
		buyerAddress: 'Str. Înțelepciunii 3\n400001 Cluj-Napoca\nCluj, RO',
		buyerCompanyName: null,
		buyerCompanyCui: null,
		buyerCompanyRegCom: null,
		netTotalCents: 4124,
		vatTotalCents: 866,
		grossTotalCents: 4990,
		mentions: '',
		...overrides
	};
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
