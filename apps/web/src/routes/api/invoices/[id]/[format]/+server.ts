import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import {
	ensureInvoiceDocument,
	invoiceDocumentFilename,
	loadInvoiceModel,
	verifyInvoiceDocToken
} from '$lib/modules/invoice/server';
import { getStorage } from '$lib/modules/media/server';
import { tokenSecretFrom } from '$lib/server/secrets';
import type { RequestHandler } from './$types';

/**
 * Fiscal-document download: `/api/invoices/<id>/<pdf|xml>`. Two ways in,
 * nothing else:
 * - an admin session (the staff surface — the orders section is admin-only);
 * - a signed, short-lived token (`?t=`) minted server-side only on pages that
 *   already authenticated the buyer's claim to THIS invoice (order success/
 *   lookup via the unguessable Stripe session id).
 * Anonymous, cross-customer, tampered or expired requests get 403/404 and no
 * bytes. Documents are stored write-once in the private S3 prefix and
 * rendered lazily on first request (see modules/invoice/documents.ts).
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const format = params.format;
	if (format !== 'pdf' && format !== 'xml') error(404);

	if (locals.user?.role !== 'admin') {
		const token = url.searchParams.get('t');
		if (!token) error(403);
		const verdict = verifyInvoiceDocToken(
			tokenSecretFrom(env),
			params.id,
			format,
			token,
			new Date()
		);
		if (!verdict.ok) error(403);
	}

	const db = getDb();
	const model = await loadInvoiceModel({ db }, params.id);
	if (!model) error(404);

	const bytes = await ensureInvoiceDocument({ db, storage: getStorage() }, model, format);
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': format === 'pdf' ? 'application/pdf' : 'application/xml',
			'content-disposition': `attachment; filename="${invoiceDocumentFilename(model.invoice, format)}"`,
			'cache-control': 'private, no-store'
		}
	});
};
