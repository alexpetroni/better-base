import { describe, expect, it } from 'vitest';
import {
	signUploadTicket,
	UPLOAD_TICKET_TTL_SECONDS,
	verifyUploadTicket
} from './upload-ticket.ts';

const SECRET = 'upload-ticket-spec-secret';
const KEY = 'uploads/2026/07/photo-abc12345.png';
const NOW = new Date('2026-07-09T10:00:00Z');

describe('upload-confirm tickets (audit L3: confirm bound to presign)', () => {
	it('round-trips for the presigned key', () => {
		const ticket = signUploadTicket(SECRET, KEY, NOW);
		expect(verifyUploadTicket(SECRET, KEY, ticket, NOW)).toEqual({ ok: true });
	});

	it('rejects the ticket for ANY other key — arbitrary objects cannot be confirmed', () => {
		const ticket = signUploadTicket(SECRET, KEY, NOW);
		expect(verifyUploadTicket(SECRET, 'seed/products/masca-somn.svg', ticket, NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('rejects a ticket signed with a foreign secret', () => {
		const ticket = signUploadTicket('other-secret', KEY, NOW);
		expect(verifyUploadTicket(SECRET, KEY, ticket, NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('rejects an expired ticket (boundary: exactly at expiry)', () => {
		const ticket = signUploadTicket(SECRET, KEY, NOW);
		const atExpiry = new Date(NOW.getTime() + UPLOAD_TICKET_TTL_SECONDS * 1000);
		expect(verifyUploadTicket(SECRET, KEY, ticket, atExpiry)).toEqual({
			ok: false,
			reason: 'expired'
		});
		const justBefore = new Date(atExpiry.getTime() - 1000);
		expect(verifyUploadTicket(SECRET, KEY, ticket, justBefore)).toEqual({ ok: true });
	});

	it('rejects a tampered expiry — the exp is covered by the signature', () => {
		const ticket = signUploadTicket(SECRET, KEY, NOW);
		const [exp, sig] = ticket.split('.');
		const forged = `${Number(exp) + 3600}.${sig}`;
		expect(verifyUploadTicket(SECRET, KEY, forged, NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('rejects malformed and missing tickets', () => {
		for (const bad of ['', 'not-a-ticket', 'abc.def', '123', '.sig', '123.']) {
			expect(verifyUploadTicket(SECRET, KEY, bad, NOW).ok).toBe(false);
		}
	});
});
