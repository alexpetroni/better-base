import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed upload-confirm tickets (audit L3): `presign` hands the browser a
 * ticket bound to the storage key it just presigned, and `confirm` refuses
 * without it. A staff session can therefore only register keys it obtained
 * through presign — never adopt arbitrary bucket objects (seed assets,
 * other users' pending uploads) as its own media rows.
 * Format `<exp>.<sig>`, HMAC-SHA256 over purpose+key+exp. Pure given
 * (secret, now) — unit-testable offline.
 */

const PURPOSE = 'media-upload-confirm';

/** Comfortably covers the 10-min presign window plus a slow multi-MB PUT. */
export const UPLOAD_TICKET_TTL_SECONDS = 60 * 60;

function signPayload(secret: string, key: string, exp: number): string {
	return createHmac('sha256', secret).update(`${PURPOSE}:${key}:${exp}`).digest('base64url');
}

export function signUploadTicket(secret: string, key: string, now: Date): string {
	const exp = Math.floor(now.getTime() / 1000) + UPLOAD_TICKET_TTL_SECONDS;
	return `${exp}.${signPayload(secret, key, exp)}`;
}

export type UploadTicketVerification =
	| { ok: true }
	| { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyUploadTicket(
	secret: string,
	key: string,
	ticket: string,
	now: Date
): UploadTicketVerification {
	const parts = ticket.split('.');
	if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !parts[1]) {
		return { ok: false, reason: 'malformed' };
	}
	const exp = Number(parts[0]);

	const expected = Buffer.from(signPayload(secret, key, exp));
	const actual = Buffer.from(parts[1]);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return { ok: false, reason: 'signature' };
	}
	if (exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
	return { ok: true };
}
