// Authorization for scheduled HTTP jobs. On a VPS the retention job runs from
// cron as a script; on Vercel there is no machine to run scripts on, so it is
// an HTTP route instead — which means it needs a lock on the door.
//
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
// CRON_SECRET is set on the project. Framework-free so it can be unit-tested
// without an HTTP layer.
import { timingSafeEqual } from 'node:crypto';

export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

/**
 * Constant-time check of a cron request's `Authorization` header.
 *
 * A MISSING secret is 503, not 401: an unconfigured deploy must not look like
 * a rejected caller, and it must never fall open (an empty expected secret
 * would otherwise match an empty header). Same length-guard + timingSafeEqual
 * shape as the HMAC token checks in the modules' `token.ts` files.
 */
export function authorizeCron(
	authorization: string | null,
	secret: string | undefined
): CronAuthResult {
	if (!secret) return { ok: false, status: 503, reason: 'CRON_SECRET is not set' };
	if (!authorization?.startsWith('Bearer ')) {
		return { ok: false, status: 401, reason: 'missing bearer token' };
	}
	const provided = Buffer.from(authorization.slice('Bearer '.length));
	const expected = Buffer.from(secret);
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		return { ok: false, status: 401, reason: 'invalid token' };
	}
	return { ok: true };
}
