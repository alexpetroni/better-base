// Server module barrel: the fiscal-record schema and the issuance service.
export { invoiceLines, invoices, invoiceSeries } from './schema.ts';
export {
	allocateInvoiceNumber,
	composeDisplayNumber,
	ensureInvoicesForOrder,
	issueInvoiceForOrderInTx,
	issueStornoForOrderInTx,
	listInvoiceLines,
	listInvoicesForOrder,
	missingIssuerSettings,
	REQUIRED_ISSUER_SETTINGS,
	type EnsuredDocuments,
	type InvoiceDeps,
	type InvoiceError,
	type InvoiceItemInput,
	type InvoiceResult,
	type IssuedDocument
} from './service.ts';
