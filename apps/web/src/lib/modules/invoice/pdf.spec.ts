import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import type { InvoiceLineRow, InvoiceRow } from './schema.ts';
import type { InvoiceDocumentModel } from './model.ts';
import { invoiceDateIso, invoiceDateRo, invoiceDocumentFilename } from './model.ts';
import { formatVatRateBp, renderInvoicePdf } from './pdf.ts';

// The PDF is the customer- and accountant-facing document: it must be
// byte-deterministic (write-once storage + honest caching depend on it),
// carry every legally required field in its TEXT layer (not just pixels),
// and survive Romanian diacritics — the embedded DejaVu Sans is the whole
// reason the font ships with the repo.

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

function makeLine(overrides: Partial<InvoiceLineRow> = {}): InvoiceLineRow {
	return {
		id: 'line-1',
		invoiceId: 'inv-1',
		position: 1,
		description: 'Pernă cu spumă cu memorie „Vise Line”',
		qty: 1,
		unitPriceCents: 4990,
		vatRateBp: 2100,
		netCents: 4124,
		vatCents: 866,
		grossCents: 4990,
		...overrides
	};
}

function makeModel(
	invoice: Partial<InvoiceRow> = {},
	lines?: InvoiceLineRow[],
	stornoOf: InvoiceDocumentModel['stornoOf'] = null
): InvoiceDocumentModel {
	return { invoice: { ...makeInvoice(), ...invoice }, lines: lines ?? [makeLine()], stornoOf };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
	// Copy the bytes: pdf.js transfers (detaches) the buffer it is given.
	const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), {
		mergePages: true
	});
	return text;
}

describe('renderInvoicePdf', () => {
	it('is deterministic: the same snapshot renders byte-identical PDFs', async () => {
		const model = makeModel();
		const first = await renderInvoicePdf(model);
		const second = await renderInvoicePdf(model);
		expect(first.length).toBeGreaterThan(1000);
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
	});

	it('carries every legally required field in the text layer, diacritics intact', async () => {
		const text = await pdfText(
			await renderInvoicePdf(
				makeModel({ netTotalCents: 6975, vatTotalCents: 1465, grossTotalCents: 8440 }, [
					makeLine(),
					makeLine({
						id: 'line-2',
						position: 2,
						description: 'Ceai de mușețel',
						qty: 3,
						unitPriceCents: 1150,
						vatRateBp: 2100,
						netCents: 2851,
						vatCents: 599,
						grossCents: 3450
					})
				])
			)
		);

		// Document identification.
		expect(text).toContain('FACTURĂ');
		expect(text).toContain('BSL-0042');
		expect(text).toContain('07.08.2026');
		// Issuer identification — with comma-below diacritics surviving.
		expect(text).toContain('Șosete Țesute SRL');
		expect(text).toContain('RO12345676');
		expect(text).toContain('J40/1234/2025');
		expect(text).toContain('Str. Somnului 10, București');
		expect(text).toContain('RO49AAAA1B31007593840000');
		// Buyer identification.
		expect(text).toContain('Ștefan Țăranu');
		expect(text).toContain('Cluj-Napoca');
		expect(text).toContain('stefan@example.ro');
		// Lines: description, qty, unit net price, per-line net/VAT/gross.
		expect(text).toContain('Pernă cu spumă cu memorie');
		expect(text).toContain('Ceai de mușețel');
		expect(text).toContain('41,24 lei'); // line 1 net
		expect(text).toContain('8,66 lei'); // line 1 VAT
		expect(text).toContain('21%');
		expect(text).toContain('9,5033'); // line 2 unit net: 2851/3 bani
		expect(text).toContain('28,51 lei');
		expect(text).toContain('34,50 lei');
		// Totals (net / VAT / gross of the whole document).
		expect(text).toContain('Total fără TVA');
		expect(text).toContain('69,75 lei');
		expect(text).toContain('14,65 lei');
		expect(text).toContain('TOTAL DE PLATĂ');
		expect(text).toContain('84,40 lei');
		// Legal mentions/footer.
		expect(text).toContain('Emisă la București');
	});

	it('marks a storno clearly and references the original document', async () => {
		const text = await pdfText(
			await renderInvoicePdf(
				makeModel(
					{
						kind: 'storno',
						number: 43,
						displayNumber: 'BSL-0043',
						stornoOfInvoiceId: 'inv-1',
						netTotalCents: -4124,
						vatTotalCents: -866,
						grossTotalCents: -4990
					},
					[makeLine({ qty: -1, netCents: -4124, vatCents: -866, grossCents: -4990 })],
					{ displayNumber: 'BSL-0042', issuedAt: new Date('2026-08-01T08:00:00Z') }
				)
			)
		);
		expect(text).toContain('FACTURĂ STORNO');
		expect(text).toContain('BSL-0043');
		expect(text).toContain('Stornează factura BSL-0042 din 01.08.2026');
		expect(text).toContain('-49,90 lei');
	});

	it('prints the VAT-unregistered mention and 0% lines for a neplătitor', async () => {
		const text = await pdfText(
			await renderInvoicePdf(
				makeModel(
					{
						issuerVatRegistered: false,
						netTotalCents: 4990,
						vatTotalCents: 0,
						grossTotalCents: 4990,
						mentions: 'Neplătitor de TVA'
					},
					[makeLine({ vatRateBp: 0, netCents: 4990, vatCents: 0, grossCents: 4990 })]
				)
			)
		);
		expect(text).toContain('Neplătitor de TVA');
		expect(text).toContain('0%');
		expect(text).toContain('0,00 lei');
	});
});

describe('share capital, payment and order reference (FIX-12)', () => {
	it('prints the share capital under Reg. Com. and "Achitat cu cardul la <data>" with the order reference', async () => {
		const text = await pdfText(await renderInvoicePdf(makeModel()));
		expect(text).toContain('Capital social: 200 lei');
		// The capital follows the Reg. Com. line in the issuer block.
		expect(text.indexOf('Capital social')).toBeGreaterThan(text.indexOf('J40/1234/2025'));
		expect(text).toContain('Achitat cu cardul la 07.08.2026');
		expect(text).toContain('pi_test_order_1');
		expect(text).toContain('Comandă: order-1');
	});

	it('a PFA without share capital and an unpaid document print neither line', async () => {
		const text = await pdfText(
			await renderInvoicePdf(
				makeModel({ issuerCapital: '', paidAt: null, paymentMethod: '', paymentReference: '' })
			)
		);
		expect(text).not.toContain('Capital social');
		expect(text).not.toContain('Achitat');
		expect(text).toContain('Comandă: order-1');
	});

	it('an online (non-card) payment prints "Achitat online"', async () => {
		const text = await pdfText(await renderInvoicePdf(makeModel({ paymentMethod: 'online' })));
		expect(text).toContain('Achitat online la 07.08.2026');
	});
});

describe('formatVatRateBp', () => {
	it('formats whole and fractional rates', () => {
		expect(formatVatRateBp(2100)).toBe('21%');
		expect(formatVatRateBp(1950)).toBe('19,5%');
		expect(formatVatRateBp(0)).toBe('0%');
		expect(formatVatRateBp(525)).toBe('5,25%');
	});
});

describe('invoice date + filename helpers', () => {
	it('formats dates in Europe/Bucharest, not UTC', () => {
		// 22:30 UTC on Aug 6 is already Aug 7 in Bucharest (EEST, UTC+3).
		const lateEvening = new Date('2026-08-06T22:30:00Z');
		expect(invoiceDateIso(lateEvening)).toBe('2026-08-07');
		expect(invoiceDateRo(lateEvening)).toBe('07.08.2026');
	});

	it('builds ASCII download filenames per document kind', () => {
		expect(invoiceDocumentFilename(makeInvoice(), 'pdf')).toBe('Factura-BSL-0042.pdf');
		expect(
			invoiceDocumentFilename(makeInvoice({ kind: 'storno', displayNumber: 'BSL-0043' }), 'xml')
		).toBe('Storno-BSL-0043.xml');
	});
});
