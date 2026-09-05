import { centsPerUnitToDecimal, centsToDecimal } from '../../util/money.ts';
import {
	BUCHAREST_COUNTY_CODE,
	bucharestSector,
	ROMANIA_COUNTRY_CODE
} from '../../util/ro-counties.ts';
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

/**
 * Bumped whenever the XML output changes (same role as the PDF's): 1 = the
 * pre-FIX-12 output (rejected by CIUS-RO for any RO address); 2 = FIX-12.
 */
export const EFACTURA_RENDERER_VERSION = 2;

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

/**
 * The exemption reason (BT-120) for category O: the snapshot's dedicated
 * column since FIX-12. Rows issued before it carry '' there and fall back
 * to their first mention line (the service composed the neplătitor mention
 * first); the generic legal term is the last resort for an emptied mention.
 */
export function vatExemptionReason(invoice: InvoiceRow): string {
	if (invoice.vatExemptionReason) return invoice.vatExemptionReason;
	return invoice.mentions.split('\n').find((line) => line.length > 0) ?? 'Neplătitor de TVA';
}

/**
 * UNCL4461 payment means code for how the order was settled: 48 = bank
 * card (the platform's pinned default), 68 = online payment service (a
 * session open to whatever the Stripe dashboard enables).
 */
export function paymentMeansCodeFor(invoice: InvoiceRow): string | null {
	if (!invoice.paidAt || !invoice.paymentMethod) return null;
	return invoice.paymentMethod === 'card' ? '48' : '68';
}

/** A party's structured address, with the legacy fallback for pre-FIX-12 rows. */
export interface PartyAddress {
	street: string;
	city: string;
	postalZone: string;
	countrySubentity: string;
	countryCode: string;
}

/**
 * BR-RO-A20: under RO-B the CityName is the sector (`SECTOR3`), which the
 * customer may have typed in the city or in the street text. A București
 * address naming no sector is emitted as given — and flagged by the
 * validator, so the gap is visible rather than guessed.
 */
export function cityNameFor(address: Pick<PartyAddress, 'street' | 'city' | 'countrySubentity'>) {
	if (address.countrySubentity !== BUCHAREST_COUNTY_CODE) return address.city;
	const sector = bucharestSector(address.city) ?? bucharestSector(address.street);
	return sector === null ? address.city : `SECTOR${sector}`;
}

export function supplierAddress(invoice: InvoiceRow): PartyAddress {
	if (invoice.issuerStreet) {
		return {
			street: invoice.issuerStreet,
			city: invoice.issuerCity,
			postalZone: invoice.issuerPostalCode,
			countrySubentity: invoice.issuerCounty,
			countryCode: invoice.issuerCountry || ROMANIA_COUNTRY_CODE
		};
	}
	// Pre-FIX-12 snapshot: one flattened string, no county — the validator
	// reports the missing subentity for the operator.
	return {
		street: invoice.issuerAddress,
		city: invoice.issuerPlace || invoice.issuerAddress,
		postalZone: '',
		countrySubentity: '',
		countryCode: ROMANIA_COUNTRY_CODE
	};
}

export function customerAddress(invoice: InvoiceRow): PartyAddress {
	if (invoice.buyerStreet) {
		return {
			street: invoice.buyerStreet,
			city: invoice.buyerCity,
			postalZone: invoice.buyerPostalCode,
			countrySubentity: invoice.buyerCounty,
			countryCode: invoice.buyerCountry || ROMANIA_COUNTRY_CODE
		};
	}
	// Pre-FIX-12 snapshot: printable lines — first = street, second = the
	// postal/city line.
	const lines = invoice.buyerAddress.split('\n').filter(Boolean);
	return {
		street: lines[0] ?? invoice.buyerName,
		city: lines[1] ?? lines[0] ?? '',
		postalZone: '',
		countrySubentity: '',
		countryCode: ROMANIA_COUNTRY_CODE
	};
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
	address: PartyAddress;
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
	// UBL PostalAddress order: StreetName, CityName, PostalZone, CountrySubentity, Country.
	return (
		'<cac:Party>' +
		'<cac:PostalAddress>' +
		el('cbc:StreetName', opts.address.street) +
		el('cbc:CityName', cityNameFor(opts.address)) +
		el('cbc:PostalZone', opts.address.postalZone) +
		el('cbc:CountrySubentity', opts.address.countrySubentity) +
		`<cac:Country><cbc:IdentificationCode>${esc(opts.address.countryCode)}</cbc:IdentificationCode></cac:Country>` +
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
 * Render the snapshot as RO_CIUS UBL 2.1 XML. Addresses come from the
 * structured snapshot columns (street / city / PostalZone / the ISO
 * 3166-2:RO CountrySubentity, SECTORn for București); a card-paid document
 * is PREPAID (means 48 + PaymentID, PrepaidAmount = total, PayableAmount 0);
 * the order id rides as OrderReference. Under category O the BUYER's VAT
 * identifier is suppressed as well (BR-O-2).
 */
export function renderEFacturaXml(model: InvoiceDocumentModel): string {
	const { invoice, lines, stornoOf } = model;
	const currency = invoice.currency.toUpperCase();
	const exemption = invoice.issuerVatRegistered ? '' : vatExemptionReason(invoice);
	const prepaid = invoice.paidAt !== null;
	const meansCode = paymentMeansCodeFor(invoice);

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
		(invoice.orderReference
			? `<cac:OrderReference>${el('cbc:ID', invoice.orderReference)}</cac:OrderReference>`
			: '') +
		(stornoOf
			? '<cac:BillingReference><cac:InvoiceDocumentReference>' +
				el('cbc:ID', stornoOf.displayNumber) +
				el('cbc:IssueDate', invoiceDateIso(stornoOf.issuedAt)) +
				'</cac:InvoiceDocumentReference></cac:BillingReference>'
			: '') +
		'<cac:AccountingSupplierParty>' +
		partyXml({
			name: invoice.issuerName,
			address: supplierAddress(invoice),
			vatId: invoice.issuerVatRegistered ? invoice.issuerCui : undefined,
			legalId: invoice.issuerCui,
			// BT-33: Reg. Com. and (Legea 31/1990 art. 74) the share capital.
			legalForm:
				[
					invoice.issuerRegCom ? `Nr. Reg. Com.: ${invoice.issuerRegCom}` : '',
					invoice.issuerCapital ? `Capital social: ${invoice.issuerCapital}` : ''
				]
					.filter(Boolean)
					.join('; ') || undefined,
			email: invoice.issuerEmail || undefined,
			phone: invoice.issuerPhone || undefined
		}) +
		'</cac:AccountingSupplierParty>' +
		'<cac:AccountingCustomerParty>' +
		partyXml({
			name: invoice.buyerCompanyName ?? invoice.buyerName,
			address: customerAddress(invoice),
			// BR-O-2: no VAT identifiers at all on a category-O document.
			vatId:
				invoice.issuerVatRegistered &&
				invoice.buyerCompanyCui &&
				/^RO\d+$/i.test(invoice.buyerCompanyCui)
					? invoice.buyerCompanyCui
					: undefined,
			legalId: invoice.buyerCompanyCui ?? undefined,
			legalForm: invoice.buyerCompanyRegCom
				? `Nr. Reg. Com.: ${invoice.buyerCompanyRegCom}`
				: undefined,
			email: invoice.buyerEmail || undefined
		}) +
		'</cac:AccountingCustomerParty>' +
		// Settled online: the means it was paid by, with the processor's
		// reference; otherwise the account to pay into.
		(meansCode
			? `<cac:PaymentMeans>${el('cbc:PaymentMeansCode', meansCode)}${el(
					'cbc:PaymentID',
					invoice.paymentReference || undefined
				)}</cac:PaymentMeans>`
			: invoice.issuerIban
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
		// BR-CO-16: payable = inclusive − prepaid. A settled document owes 0.
		(prepaid ? amount('cbc:PrepaidAmount', invoice.grossTotalCents, currency) : '') +
		amount('cbc:PayableAmount', prepaid ? 0 : invoice.grossTotalCents, currency) +
		'</cac:LegalMonetaryTotal>' +
		lineXml +
		'</Invoice>'
	);
}
