import { describe, expect, it } from 'vitest';
import {
	INVOICE_DOC_TOKEN_TTL_SECONDS,
	invoiceDocPath,
	signInvoiceDocToken,
	verifyInvoiceDocToken
} from './access.ts';

// The customer-access token is the only thing between an invoice PDF and the
// open internet — sign/verify must bind the exact invoice AND format, and
// expire. Pure crypto, tested offline.

const SECRET = 'invoice-access-test-secret';
const NOW = new Date('2026-08-07T12:00:00Z');

describe('invoice document tokens', () => {
	it('round-trips for the same invoice, format and window', () => {
		const token = signInvoiceDocToken(SECRET, 'inv-1', 'pdf', NOW);
		expect(verifyInvoiceDocToken(SECRET, 'inv-1', 'pdf', token, NOW)).toEqual({ ok: true });
		// Still valid just before expiry…
		const lastMoment = new Date(NOW.getTime() + (INVOICE_DOC_TOKEN_TTL_SECONDS - 1) * 1000);
		expect(verifyInvoiceDocToken(SECRET, 'inv-1', 'pdf', token, lastMoment)).toEqual({ ok: true });
	});

	it('expires', () => {
		const token = signInvoiceDocToken(SECRET, 'inv-1', 'pdf', NOW);
		const afterExpiry = new Date(NOW.getTime() + (INVOICE_DOC_TOKEN_TTL_SECONDS + 1) * 1000);
		expect(verifyInvoiceDocToken(SECRET, 'inv-1', 'pdf', token, afterExpiry)).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('is bound to the invoice id and the format — no cross-use', () => {
		const token = signInvoiceDocToken(SECRET, 'inv-1', 'pdf', NOW);
		expect(verifyInvoiceDocToken(SECRET, 'inv-OTHER', 'pdf', token, NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
		expect(verifyInvoiceDocToken(SECRET, 'inv-1', 'xml', token, NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
		expect(verifyInvoiceDocToken('other-secret', 'inv-1', 'pdf', token, NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('rejects tampered and malformed tokens', () => {
		const token = signInvoiceDocToken(SECRET, 'inv-1', 'pdf', NOW);
		const [exp, sig] = token.split('.');
		// Extending the expiry invalidates the signature.
		expect(
			verifyInvoiceDocToken(SECRET, 'inv-1', 'pdf', `${Number(exp) + 3600}.${sig}`, NOW)
		).toEqual({ ok: false, reason: 'signature' });
		for (const bad of ['', 'garbage', `${exp}.`, `.${sig}`, `${exp}.${sig}.extra`, `x.${sig}`]) {
			expect(verifyInvoiceDocToken(SECRET, 'inv-1', 'pdf', bad, NOW)).toEqual({
				ok: false,
				reason: 'malformed'
			});
		}
	});

	it('builds the download path with and without a token', () => {
		expect(invoiceDocPath('inv-1', 'pdf')).toBe('/api/invoices/inv-1/pdf');
		expect(invoiceDocPath('inv-1', 'xml', '123.abc')).toBe('/api/invoices/inv-1/xml?t=123.abc');
	});
});
