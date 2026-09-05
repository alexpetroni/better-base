// Server module barrel: the fiscal-record schema, the issuance service and
// the document layer (PDF/XML rendering, storage, signed access, e-Factura).
import { env } from '$env/dynamic/private';
import { selectEFacturaSubmitter, type EFacturaSubmitter } from './efactura-submitter.ts';

export { invoiceLines, invoices, invoiceSeries, invoiceSubmissions } from './schema.ts';
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
	EFACTURA_DEADLINE_DAYS,
	EFACTURA_MAX_ATTEMPTS,
	efacturaDaysLeftSql,
	recordPendingSubmissionInTx,
	submitPendingEFactura,
	type EFacturaDrainDeps,
	type EFacturaDrainResult
} from './submissions.ts';
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

/** Env-bound submitter singleton: the no-op until a human enrolls with ANAF. */
let submitterInstance: EFacturaSubmitter | undefined;
export function getEFacturaSubmitter(): EFacturaSubmitter {
	submitterInstance ??= selectEFacturaSubmitter(env);
	return submitterInstance;
}
