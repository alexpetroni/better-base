import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, short-lived customer access to ONE invoice document (upload-ticket
 * pattern): the token binds invoice id + format + expiry under TOKEN_SECRET.
 * Tokens are minted server-side only for documents the requester already
 * proved they own (the order success/lookup page resolves the order through
 * its unguessable Stripe session id; the confirmation email links back to
 * that page) — so a customer can never obtain a token for someone else's
 * invoice, and an expired or tampered token is refused. Staff sessions skip
 * tokens entirely (the route checks the admin role). Format `<exp>.<sig>`,
 * HMAC-SHA256, pure given (secret, now) — unit-testable offline.
 */

const PURPOSE = 'invoice-document';

export type InvoiceDocFormat = 'pdf' | 'xml';

/** Fresh links are minted on every success-page load; 15 min is plenty. */
export const INVOICE_DOC_TOKEN_TTL_SECONDS = 15 * 60;

function signPayload(secret: string, invoiceId: string, format: string, exp: number): string {
	return createHmac('sha256', secret)
		.update(`${PURPOSE}:${invoiceId}:${format}:${exp}`)
		.digest('base64url');
}

export function signInvoiceDocToken(
	secret: string,
	invoiceId: string,
	format: InvoiceDocFormat,
	now: Date
): string {
	const exp = Math.floor(now.getTime() / 1000) + INVOICE_DOC_TOKEN_TTL_SECONDS;
	return `${exp}.${signPayload(secret, invoiceId, format, exp)}`;
}

export type InvoiceDocTokenVerification =
	{ ok: true } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyInvoiceDocToken(
	secret: string,
	invoiceId: string,
	format: InvoiceDocFormat,
	token: string,
	now: Date
): InvoiceDocTokenVerification {
	const parts = token.split('.');
	if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !parts[1]) {
		return { ok: false, reason: 'malformed' };
	}
	const exp = Number(parts[0]);

	const expected = Buffer.from(signPayload(secret, invoiceId, format, exp));
	const actual = Buffer.from(parts[1]);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return { ok: false, reason: 'signature' };
	}
	if (exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
	return { ok: true };
}

/** The relative download URL the app links and emails point at. */
export function invoiceDocPath(
	invoiceId: string,
	format: InvoiceDocFormat,
	token?: string
): string {
	const base = `/api/invoices/${invoiceId}/${format}`;
	return token ? `${base}?t=${token}` : base;
}
