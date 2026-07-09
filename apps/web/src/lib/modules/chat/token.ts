import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed chat-session cookie tokens: `<sessionId>.<anonymousToken>.<sig>`.
 * The HMAC covers both ids, so a token can neither be forged nor re-pointed
 * at another session. No expiry claim — retention is enforced by pruning the
 * session rows, and a token for a pruned session simply starts a fresh one.
 * Pure given the secret — unit-testable offline.
 */
const PURPOSE = 'chat-session';

function signPayload(secret: string, sessionId: string, anonymousToken: string): string {
	return createHmac('sha256', secret)
		.update(`${PURPOSE}:${sessionId}:${anonymousToken}`)
		.digest('base64url');
}

export function signSessionToken(
	secret: string,
	sessionId: string,
	anonymousToken: string
): string {
	return `${sessionId}.${anonymousToken}.${signPayload(secret, sessionId, anonymousToken)}`;
}

export type SessionTokenVerification =
	| { ok: true; sessionId: string; anonymousToken: string }
	| { ok: false; reason: 'malformed' | 'signature' };

export function verifySessionToken(secret: string, token: string): SessionTokenVerification {
	const parts = token.split('.');
	if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: 'malformed' };
	const [sessionId, anonymousToken, signature] = parts;

	const expected = Buffer.from(signPayload(secret, sessionId, anonymousToken));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return { ok: false, reason: 'signature' };
	}
	return { ok: true, sessionId, anonymousToken };
}
