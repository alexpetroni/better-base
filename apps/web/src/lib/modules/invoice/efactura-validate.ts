import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { EFACTURA_CUSTOMIZATION_ID } from './efactura.ts';
import type { InvoiceDocumentModel } from './model.ts';

/**
 * Offline validation of a generated e-Factura document: everything that can
 * be checked without ANAF — well-formedness, the UBL/CIUS-RO structure, the
 * EN 16931 arithmetic rules (BR-CO-10/13/14/15, BR-CO-17 with a documented
 * per-line-rounding tolerance, BR-O for the VAT-unregistered case) and, given
 * the source snapshot, exact agreement with the stored record. This is NOT
 * the official ANAF schematron (that runs at submission / in their web
 * validator, which needs their tooling); it is the tripwire that keeps our
 * generator from ever emitting a structurally or arithmetically broken file.
 * Returns a list of problems — empty means valid.
 */

const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';

type XmlNode = Record<string, unknown>;

/** "41.24" → 4124; null when not a plain 2-decimal amount. */
function parseAmountCents(value: unknown): number | null {
	const text = String(value ?? '');
	const match = /^(-?)(\d+)\.(\d{2})$/.exec(text);
	if (!match) return null;
	const cents = Number(match[2]) * 100 + Number(match[3]);
	return match[1] === '-' ? -cents : cents;
}

/** "41.2400" → 412400 (hundredths of a ban); accepts 0–4 decimals. */
function parsePriceTenThousandths(value: unknown): number | null {
	const text = String(value ?? '');
	const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(text);
	if (!match) return null;
	const scaled = Number(match[2]) * 10_000 + Number((match[3] ?? '').padEnd(4, '0') || '0');
	return match[1] === '-' ? -scaled : scaled;
}

function asArray(value: unknown): XmlNode[] {
	if (value === undefined || value === null) return [];
	return (Array.isArray(value) ? value : [value]) as XmlNode[];
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
	const value = node?.[name];
	if (value === undefined || value === null) return undefined;
	return (Array.isArray(value) ? value[0] : value) as XmlNode;
}

/** Text content of `<name>` under node ('' when absent). */
function text(node: XmlNode | undefined, name: string): string {
	const value = node?.[name];
	if (value === undefined || value === null) return '';
	if (typeof value === 'object' && !Array.isArray(value)) {
		return String((value as XmlNode)['#text'] ?? '');
	}
	return String(Array.isArray(value) ? ((value[0] as XmlNode)?.['#text'] ?? value[0]) : value);
}

export function validateEFacturaXml(xml: string, model?: InvoiceDocumentModel): string[] {
	const problems: string[] = [];

	const wellFormed = XMLValidator.validate(xml);
	if (wellFormed !== true) {
		return [`not well-formed XML: ${wellFormed.err.msg}`];
	}

	const parsed = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: '@_',
		parseTagValue: false,
		parseAttributeValue: false
	}).parse(xml) as XmlNode;

	const invoice = child(parsed, 'Invoice');
	if (!invoice) return ['missing root <Invoice>'];

	// --- Namespaces + profile.
	if (invoice['@_xmlns'] !== NS_INVOICE) problems.push('wrong default namespace');
	if (invoice['@_xmlns:cac'] !== NS_CAC) problems.push('wrong cac namespace');
	if (invoice['@_xmlns:cbc'] !== NS_CBC) problems.push('wrong cbc namespace');
	if (text(invoice, 'cbc:CustomizationID') !== EFACTURA_CUSTOMIZATION_ID) {
		problems.push('CustomizationID is not the CIUS-RO identifier');
	}
	if (text(invoice, 'cbc:UBLVersionID') !== '2.1') problems.push('UBLVersionID must be 2.1');

	// --- Document identification.
	const id = text(invoice, 'cbc:ID');
	if (!id) problems.push('missing invoice number (cbc:ID)');
	for (const dateField of ['cbc:IssueDate', 'cbc:DueDate']) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(text(invoice, dateField))) {
			problems.push(`${dateField} is not an ISO date`);
		}
	}
	if (text(invoice, 'cbc:InvoiceTypeCode') !== '380') {
		problems.push('InvoiceTypeCode must be 380 (RO storno = negative 380, not 381)');
	}
	const currency = text(invoice, 'cbc:DocumentCurrencyCode');
	if (!/^[A-Z]{3}$/.test(currency)) problems.push('DocumentCurrencyCode must be ISO 4217');

	// --- Parties.
	const supplier = child(child(invoice, 'cac:AccountingSupplierParty'), 'cac:Party');
	const supplierLegal = child(supplier, 'cac:PartyLegalEntity');
	if (!text(supplierLegal, 'cbc:RegistrationName')) problems.push('missing supplier name');
	if (!text(supplierLegal, 'cbc:CompanyID')) problems.push('missing supplier CUI (BT-30)');
	const supplierAddress = child(supplier, 'cac:PostalAddress');
	if (!text(supplierAddress, 'cbc:StreetName')) problems.push('missing supplier street');
	if (!text(supplierAddress, 'cbc:CityName')) problems.push('missing supplier city');
	if (!/^[A-Z]{2}$/.test(text(child(supplierAddress, 'cac:Country'), 'cbc:IdentificationCode'))) {
		problems.push('missing supplier country code');
	}
	const customer = child(child(invoice, 'cac:AccountingCustomerParty'), 'cac:Party');
	if (!text(child(customer, 'cac:PartyLegalEntity'), 'cbc:RegistrationName')) {
		problems.push('missing customer name');
	}
	if (!child(customer, 'cac:PostalAddress')) problems.push('missing customer address');

	// --- Lines.
	const lines = asArray(invoice['cac:InvoiceLine']);
	if (lines.length === 0) problems.push('no invoice lines');
	let lineNetSum = 0;
	for (const line of lines) {
		const lineId = text(line, 'cbc:ID') || '?';
		const qtyNode = line['cbc:InvoicedQuantity'];
		const qty = Number(text(line, 'cbc:InvoicedQuantity'));
		if (!Number.isInteger(qty) || qty === 0) problems.push(`line ${lineId}: bad quantity`);
		if ((qtyNode as XmlNode)?.['@_unitCode'] !== 'H87') {
			problems.push(`line ${lineId}: missing unit code`);
		}
		const net = parseAmountCents(text(line, 'cbc:LineExtensionAmount'));
		if (net === null) {
			problems.push(`line ${lineId}: LineExtensionAmount is not a 2-decimal amount`);
			continue;
		}
		lineNetSum += net;
		const item = child(line, 'cac:Item');
		if (!text(item, 'cbc:Name')) problems.push(`line ${lineId}: missing item name`);
		const category = child(item, 'cac:ClassifiedTaxCategory');
		const categoryId = text(category, 'cbc:ID');
		if (!['S', 'Z', 'O'].includes(categoryId)) {
			problems.push(`line ${lineId}: unknown VAT category "${categoryId}"`);
		}
		if (categoryId === 'O' && text(category, 'cbc:Percent') !== '') {
			problems.push(`line ${lineId}: category O must not carry a percent (BR-O)`);
		}
		if (categoryId !== 'O' && text(category, 'cbc:Percent') === '') {
			problems.push(`line ${lineId}: missing VAT percent`);
		}
		// BR-27-adjacent: unit price not negative; qty × price ≈ line net
		// (unit price is the 4-decimal division of the net, so the product can
		// be off by at most half a ban per unit).
		const price = parsePriceTenThousandths(text(child(line, 'cac:Price'), 'cbc:PriceAmount'));
		if (price === null || price < 0) {
			problems.push(`line ${lineId}: item net price must be a non-negative amount`);
		} else {
			const productCents = Math.round((price * qty) / 100);
			if (Math.abs(productCents - net) > Math.ceil(Math.abs(qty) / 2)) {
				problems.push(`line ${lineId}: qty × unit price disagrees with the line net`);
			}
		}
	}

	// --- Tax totals.
	const taxTotal = child(invoice, 'cac:TaxTotal');
	const taxAmount = parseAmountCents(text(taxTotal, 'cbc:TaxAmount'));
	const subtotals = asArray(taxTotal?.['cac:TaxSubtotal']);
	if (taxAmount === null) problems.push('missing TaxTotal amount');
	if (subtotals.length === 0) problems.push('missing TaxSubtotal');
	let subtotalTaxSum = 0;
	let subtotalTaxableSum = 0;
	for (const subtotal of subtotals) {
		const taxable = parseAmountCents(text(subtotal, 'cbc:TaxableAmount'));
		const tax = parseAmountCents(text(subtotal, 'cbc:TaxAmount'));
		const category = child(subtotal, 'cac:TaxCategory');
		const categoryId = text(category, 'cbc:ID');
		if (taxable === null || tax === null) {
			problems.push('TaxSubtotal amounts are not 2-decimal amounts');
			continue;
		}
		subtotalTaxSum += tax;
		subtotalTaxableSum += taxable;
		if (categoryId === 'O') {
			if (tax !== 0) problems.push('category O subtotal must have zero tax (BR-O)');
			if (!text(category, 'cbc:TaxExemptionReason')) {
				problems.push('category O subtotal must carry an exemption reason (BR-O)');
			}
		} else {
			// BR-CO-17, with tolerance: per-line half-up rounding lets the
			// category tax differ from rate × taxable by up to 1 ban per line
			// in the category (documented in the module README).
			const percentText = text(category, 'cbc:Percent');
			const percentMatch = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percentText);
			if (!percentMatch) {
				problems.push(`subtotal ${categoryId}: bad VAT percent "${percentText}"`);
			} else {
				const rateBp =
					Number(percentMatch[1]) * 100 + Number((percentMatch[2] ?? '').padEnd(2, '0') || '0');
				const expected = Math.round((taxable * rateBp) / 10_000);
				if (Math.abs(expected - tax) > Math.max(1, lines.length)) {
					problems.push(
						`subtotal ${categoryId}: tax ${tax} too far from rate × taxable (${expected})`
					);
				}
			}
		}
	}

	// --- Monetary totals (BR-CO-10/13/14/15/16).
	const monetary = child(invoice, 'cac:LegalMonetaryTotal');
	const lineExtension = parseAmountCents(text(monetary, 'cbc:LineExtensionAmount'));
	const taxExclusive = parseAmountCents(text(monetary, 'cbc:TaxExclusiveAmount'));
	const taxInclusive = parseAmountCents(text(monetary, 'cbc:TaxInclusiveAmount'));
	const payable = parseAmountCents(text(monetary, 'cbc:PayableAmount'));
	if (
		lineExtension === null ||
		taxExclusive === null ||
		taxInclusive === null ||
		payable === null
	) {
		problems.push('LegalMonetaryTotal amounts missing or not 2-decimal');
	} else if (taxAmount !== null) {
		if (lineExtension !== lineNetSum) problems.push('sum of line nets ≠ LineExtensionAmount');
		if (taxExclusive !== lineExtension) problems.push('TaxExclusiveAmount ≠ LineExtensionAmount');
		if (taxInclusive !== taxExclusive + taxAmount) {
			problems.push('TaxInclusiveAmount ≠ TaxExclusiveAmount + tax');
		}
		if (payable !== taxInclusive) problems.push('PayableAmount ≠ TaxInclusiveAmount');
		if (subtotalTaxSum !== taxAmount) problems.push('TaxTotal ≠ sum of subtotal taxes');
		if (subtotalTaxableSum !== lineNetSum) problems.push('subtotal taxables ≠ sum of line nets');
	}

	// --- Agreement with the stored snapshot, when provided.
	if (model) {
		const { invoice: row, lines: rows, stornoOf } = model;
		if (id !== row.displayNumber) problems.push('cbc:ID ≠ snapshot display number');
		if (lines.length !== rows.length) problems.push('line count ≠ snapshot');
		if (lineExtension !== row.netTotalCents) problems.push('net total ≠ snapshot');
		if (taxAmount !== row.vatTotalCents) problems.push('VAT total ≠ snapshot');
		if (payable !== row.grossTotalCents) problems.push('gross total ≠ snapshot');
		if (currency !== row.currency.toUpperCase()) problems.push('currency ≠ snapshot');
		const reference = child(child(invoice, 'cac:BillingReference'), 'cac:InvoiceDocumentReference');
		if (row.kind === 'storno') {
			if (text(reference, 'cbc:ID') !== stornoOf?.displayNumber) {
				problems.push('storno must reference the original document number');
			}
		} else if (reference) {
			problems.push('plain invoice must not carry a BillingReference');
		}
	}

	return problems;
}
