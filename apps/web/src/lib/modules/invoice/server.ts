// Server module barrel: the fiscal-record schema, the issuance service and
// the document layer (PDF/XML rendering, storage, signed access, e-Factura).
export { invoiceLines, invoices, invoiceSeries } from './schema.ts';
export {
	INVOICE_DOC_TOKEN_TTL_SECONDS,
	invoiceDocPath,
	signInvoiceDocToken,
	verifyInvoiceDocToken,
	type InvoiceDocFormat,
	type InvoiceDocTokenVerification
} from './access.ts';
export {
	ensureInvoiceDocument,
	ensureInvoiceDocuments,
	INVOICE_DOC_PREFIX,
	invoiceDocumentKey,
	invoicePdfAttachmentForOrder,
	loadInvoiceModel,
	type InvoiceDocumentDeps
} from './documents.ts';
export { renderEFacturaXml } from './efactura.ts';
export { validateEFacturaXml } from './efactura-validate.ts';
export {
	noopEFacturaSubmitter,
	selectEFacturaSubmitter,
	type EFacturaSubmitOutcome,
	type EFacturaSubmitter
} from './efactura-submitter.ts';
export {
	invoiceDateIso,
	invoiceDateRo,
	invoiceDocumentFilename,
	type InvoiceDocumentModel
} from './model.ts';
export { renderInvoicePdf } from './pdf.ts';
export {
	allocateInvoiceNumber,
	buyerAddressFromOrder,
	composeDisplayNumber,
	composePostalAddress,
	ensureInvoicesForOrder,
	issueInvoiceForOrderInTx,
	issuePartialStornoForOrder,
	issueStornoForOrderInTx,
	listInvoiceLines,
	listInvoicesForOrder,
	missingIssuerSettings,
	REQUIRED_ISSUER_SETTINGS,
	reversedCentsFor,
	type EnsuredDocuments,
	type InvoiceDeps,
	type InvoiceError,
	type InvoiceItemInput,
	type InvoiceResult,
	type IssuedDocument,
	type IssuerSettingsProblem,
	type PostalAddressSnapshot
} from './service.ts';
