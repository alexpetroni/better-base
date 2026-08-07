import { centsPerUnitToDecimal, centsToDecimal } from '../../util/money.ts';
import { invoiceDateIso, type InvoiceDocumentModel } from './model.ts';
import type { InvoiceLineRow, InvoiceRow } from './schema.ts';

/**
 * e-Factura XML: UBL 2.1 Invoice constrained by the RO_CIUS profile
 * (EN 16931 + Romania's CIUS-RO 1.0.1), generated from the SAME stored
 * snapshot as the PDF — the two can never disagree. Deterministic string
 * building, integer-cent math, no library. A storno is expressed the way
 * Romanian practice submits it: InvoiceTypeCode 380 with negative quantities
 * and amounts plus a BillingReference to the original document (not a 381
 * credit note). Offline validation lives in efactura-validate.ts; actual
 * submission to ANAF SPV is behind the EFacturaSubmitter seam
 * (efactura-submitter.ts) and requires human enrollment — see DEPLOYMENT.md.
 */

export const EFACTURA_CUSTOMIZATION_ID =
	'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1';

/** UN/ECE rec 20 "H87" = piece — every shop line is a count of items. */
export const EFACTURA_UNIT_CODE = 'H87';

/**
 * EN 16931 VAT category for a line/subtotal:
 * - `S` standard rate (VAT-registered issuer, positive rate);
 * - `Z` zero-rated (registered issuer, 0% — not produced today, but legal);
 * - `O` outside scope of VAT — the `neplătitor de TVA` issuer. Category O
 *   carries no Percent and requires an exemption reason (BR-O rules).
 */
export function vatCategoryFor(invoice: InvoiceRow, line: InvoiceLineRow): 'S' | 'Z' | 'O' {
	if (!invoice.issuerVatRegistered) return 'O';
	return line.vatRateBp === 0 ? 'Z' : 'S';
}

/** 2100 bp → "21"; 1950 bp → "19.5" (dot decimal — UBL numeric). */
export function bpToPercent(rateBp: number): string {
	const whole = Math.trunc(rateBp / 100);
	const frac = rateBp % 100;
	if (frac === 0) return String(whole);
	return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

function esc(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** `<cbc:ID>x</cbc:ID>`; empty/null content ⇒ element omitted entirely. */
function el(name: string, content: string | null | undefined, attrs = ''): string {
	if (content === null || content === undefined || content === '') return '';
	return `<${name}${attrs}>${esc(content)}</${name}>`;
}

function amount(name: string, cents: number, currency: string): string {
	return `<${name} currencyID="${esc(currency.toUpperCase())}">${centsToDecimal(cents)}</${name}>`;
}

/** The exemption reason for category O: the snapshotted mention. */
export function vatExemptionReason(invoice: InvoiceRow): string {
	// The service composes `mentions` with the `invoice.vatUnregisteredMention`
	// setting FIRST whenever the issuer is unregistered; the generic legal
	// term is only a fallback for a snapshot with an emptied mention.
	return invoice.mentions.split('\n').find((line) => line.length > 0) ?? 'Neplătitor de TVA';
}

interface TaxGroup {
	category: 'S' | 'Z' | 'O';
	rateBp: number;
	taxableCents: number;
	taxCents: number;
}

/** Lines grouped per (category, rate) — one TaxSubtotal each (BR-CO-18). */
export function taxGroups(model: InvoiceDocumentModel): TaxGroup[] {
	const groups = new Map<string, TaxGroup>();
	for (const line of model.lines) {
		const category = vatCategoryFor(model.invoice, line);
		const key = `${category}:${line.vatRateBp}`;
		const group = groups.get(key) ?? {
			category,
			rateBp: line.vatRateBp,
			taxableCents: 0,
			taxCents: 0
		};
		group.taxableCents += line.netCents;
		group.taxCents += line.vatCents;
		groups.set(key, group);
	}
	return [...groups.values()];
}

function partyXml(opts: {
	name: string;
	street: string;
	city: string;
	countryCode: string;
	vatId?: string;
	legalId?: string;
	legalForm?: string;
	email?: string;
	phone?: string;
}): string {
	const contact =
		opts.email || opts.phone
			? `<cac:Contact>${el('cbc:Telephone', opts.phone)}${el('cbc:ElectronicMail', opts.email)}</cac:Contact>`
			: '';
	return (
		'<cac:Party>' +
		'<cac:PostalAddress>' +
		el('cbc:StreetName', opts.street) +
		el('cbc:CityName', opts.city) +
		`<cac:Country><cbc:IdentificationCode>${esc(opts.countryCode)}</cbc:IdentificationCode></cac:Country>` +
		'</cac:PostalAddress>' +
		(opts.vatId
			? `<cac:PartyTaxScheme>${el('cbc:CompanyID', opts.vatId)}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
			: '') +
		'<cac:PartyLegalEntity>' +
		el('cbc:RegistrationName', opts.name) +
		el('cbc:CompanyID', opts.legalId) +
		el('cbc:CompanyLegalForm', opts.legalForm) +
		'</cac:PartyLegalEntity>' +
		contact +
		'</cac:Party>'
	);
}

/**
 * Render the snapshot as RO_CIUS UBL 2.1 XML. Addresses are emitted from the
 * flattened snapshot strings (street = the stored address blob); the ISO
 * 3166-2:RO county code ANAF additionally wants is not part of the NEXT-6
 * record — a documented gap of the pre-enrollment artifact (see README).
 */
export function renderEFacturaXml(model: InvoiceDocumentModel): string {
	const { invoice, lines, stornoOf } = model;
	const currency = invoice.currency.toUpperCase();
	const exemption = invoice.issuerVatRegistered ? '' : vatExemptionReason(invoice);

	// Buyer address: the snapshot stores printable lines; UBL wants
	// street/city. First line = street; the postal/city line follows it.
	const buyerLines = invoice.buyerAddress.split('\n').filter(Boolean);
	const buyerStreet = buyerLines[0] ?? invoice.buyerName;
	const buyerCity = buyerLines[1] ?? buyerLines[0] ?? '';
	// The shop ships domestically; the snapshot's flattened country (if any)
	// sits inside the address text. RO is the only market sold to (data rule:
	// the CODE stays generic — this is the sale-country of the platform).
	const countryCode = 'RO';

	const subtotals = taxGroups(model)
		.map(
			(group) =>
				'<cac:TaxSubtotal>' +
				amount('cbc:TaxableAmount', group.taxableCents, currency) +
				amount('cbc:TaxAmount', group.taxCents, currency) +
				'<cac:TaxCategory>' +
				el('cbc:ID', group.category) +
				(group.category === 'O' ? '' : el('cbc:Percent', bpToPercent(group.rateBp))) +
				(group.category === 'O' ? el('cbc:TaxExemptionReason', exemption) : '') +
				'<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>' +
				'</cac:TaxCategory>' +
				'</cac:TaxSubtotal>'
		)
		.join('');

	const lineXml = lines
		.map((line) => {
			const category = vatCategoryFor(invoice, line);
			return (
				'<cac:InvoiceLine>' +
				el('cbc:ID', String(line.position)) +
				`<cbc:InvoicedQuantity unitCode="${EFACTURA_UNIT_CODE}">${line.qty}</cbc:InvoicedQuantity>` +
				amount('cbc:LineExtensionAmount', line.netCents, currency) +
				'<cac:Item>' +
				el('cbc:Name', line.description) +
				'<cac:ClassifiedTaxCategory>' +
				el('cbc:ID', category) +
				(category === 'O' ? '' : el('cbc:Percent', bpToPercent(line.vatRateBp))) +
				'<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>' +
				'</cac:ClassifiedTaxCategory>' +
				'</cac:Item>' +
				// Unit NET price, 4 decimals (EN 16931 allows the extra precision;
				// qty × price must reproduce the line net within rounding).
				`<cac:Price><cbc:PriceAmount currencyID="${esc(currency)}">${centsPerUnitToDecimal(
					line.netCents,
					line.qty
				)}</cbc:PriceAmount></cac:Price>` +
				'</cac:InvoiceLine>'
			);
		})
		.join('');

	const notes = invoice.mentions.split('\n').filter(Boolean);

	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
		' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
		' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">' +
		el('cbc:UBLVersionID', '2.1') +
		el('cbc:CustomizationID', EFACTURA_CUSTOMIZATION_ID) +
		el('cbc:ID', invoice.displayNumber) +
		el('cbc:IssueDate', invoiceDateIso(invoice.issuedAt)) +
		el('cbc:DueDate', invoiceDateIso(invoice.dueAt)) +
		el('cbc:InvoiceTypeCode', '380') +
		notes.map((note) => el('cbc:Note', note)).join('') +
		el('cbc:DocumentCurrencyCode', currency) +
		(stornoOf
			? '<cac:BillingReference><cac:InvoiceDocumentReference>' +
				el('cbc:ID', stornoOf.displayNumber) +
				el('cbc:IssueDate', invoiceDateIso(stornoOf.issuedAt)) +
				'</cac:InvoiceDocumentReference></cac:BillingReference>'
			: '') +
		'<cac:AccountingSupplierParty>' +
		partyXml({
			name: invoice.issuerName,
			street: invoice.issuerAddress,
			city: invoice.issuerPlace || invoice.issuerAddress,
			countryCode,
			vatId: invoice.issuerVatRegistered ? invoice.issuerCui : undefined,
			legalId: invoice.issuerCui,
			legalForm: invoice.issuerRegCom ? `Nr. Reg. Com.: ${invoice.issuerRegCom}` : undefined,
			email: invoice.issuerEmail || undefined,
			phone: invoice.issuerPhone || undefined
		}) +
		'</cac:AccountingSupplierParty>' +
		'<cac:AccountingCustomerParty>' +
		partyXml({
			name: invoice.buyerCompanyName ?? invoice.buyerName,
			street: buyerStreet,
			city: buyerCity,
			countryCode,
			vatId:
				invoice.buyerCompanyCui && /^RO\d+$/i.test(invoice.buyerCompanyCui)
					? invoice.buyerCompanyCui
					: undefined,
			legalId: invoice.buyerCompanyCui ?? undefined,
			legalForm: invoice.buyerCompanyRegCom
				? `Nr. Reg. Com.: ${invoice.buyerCompanyRegCom}`
				: undefined,
			email: invoice.buyerEmail || undefined
		}) +
		'</cac:AccountingCustomerParty>' +
		(invoice.issuerIban
			? '<cac:PaymentMeans><cbc:PaymentMeansCode>42</cbc:PaymentMeansCode>' +
				`<cac:PayeeFinancialAccount>${el('cbc:ID', invoice.issuerIban)}${el(
					'cbc:Name',
					invoice.issuerBank || undefined
				)}</cac:PayeeFinancialAccount></cac:PaymentMeans>`
			: '') +
		'<cac:TaxTotal>' +
		amount('cbc:TaxAmount', invoice.vatTotalCents, currency) +
		subtotals +
		'</cac:TaxTotal>' +
		'<cac:LegalMonetaryTotal>' +
		amount('cbc:LineExtensionAmount', invoice.netTotalCents, currency) +
		amount('cbc:TaxExclusiveAmount', invoice.netTotalCents, currency) +
		amount('cbc:TaxInclusiveAmount', invoice.grossTotalCents, currency) +
		amount('cbc:PayableAmount', invoice.grossTotalCents, currency) +
		'</cac:LegalMonetaryTotal>' +
		lineXml +
		'</Invoice>'
	);
}
