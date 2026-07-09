import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring action tokens for email links (double opt-in confirm).
 * Stateless: HMAC-SHA256 over base64url claims, verified with the same
 * secret. Pure given (secret, now) — unit-testable offline.
 */

export interface TokenClaims {
	/** Subject — the subscriber id. */
	sub: string;
	purpose: string;
	/** Expiry, seconds since epoch. */
	exp: number;
}

export type TokenVerification =
	| { ok: true; sub: string }
	| { ok: false; reason: 'malformed' | 'signature' | 'purpose' | 'expired' };

function signPayload(secret: string, payload: string): string {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signToken(secret: string, claims: TokenClaims): string {
	const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
	return `${payload}.${signPayload(secret, payload)}`;
}

export function verifyToken(
	secret: string,
	token: string,
	purpose: string,
	now: Date
): TokenVerification {
	const parts = token.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
	const [payload, signature] = parts;

	const expected = Buffer.from(signPayload(secret, payload));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return { ok: false, reason: 'signature' };
	}

	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (
		typeof claims !== 'object' ||
		claims === null ||
		typeof (claims as TokenClaims).sub !== 'string' ||
		typeof (claims as TokenClaims).purpose !== 'string' ||
		typeof (claims as TokenClaims).exp !== 'number'
	) {
		return { ok: false, reason: 'malformed' };
	}
	const parsed = claims as TokenClaims;
	if (parsed.purpose !== purpose) return { ok: false, reason: 'purpose' };
	if (parsed.exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
	return { ok: true, sub: parsed.sub };
}
