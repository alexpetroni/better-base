import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Resend webhook verification and parsing (audit 2026-09-03 P1: bounces and
 * complaints were never fed back). Resend signs with the Svix scheme: the
 * endpoint secret is `whsec_<base64 key>`, the signed content is
 * `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256, base64, delivered
 * as `svix-signature: v1,<sig>` (several space-separated entries during key
 * rotation). Pure given (payload, headers, secret, now) — unit-testable
 * offline; no live call anywhere.
 */

/** Accept timestamps within this many seconds of now (replay protection). */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function verifyResendWebhook(
	payload: string,
	headers: Headers,
	secret: string,
	now = new Date()
): boolean {
	const id = headers.get('svix-id');
	const timestamp = headers.get('svix-timestamp');
	const signatures = headers.get('svix-signature');
	if (!id || !timestamp || !signatures) return false;

	const sentAt = Number(timestamp);
	if (!Number.isFinite(sentAt)) return false;
	if (Math.abs(now.getTime() / 1000 - sentAt) > RESEND_WEBHOOK_TOLERANCE_SECONDS) return false;

	const key = Buffer.from(
		secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
		'base64'
	);
	const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest();
	return signatures.split(' ').some((entry) => {
		const [version, value] = entry.split(',', 2);
		if (version !== 'v1' || !value) return false;
		const actual = Buffer.from(value, 'base64');
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	});
}

export interface ResendFeedbackEvent {
	kind: 'bounce' | 'complaint';
	/** Recipients, lowercased. */
	emails: string[];
	providerId: string | null;
}

/** The two events that withdraw an address; everything else is null (acknowledged, ignored). */
export function parseResendEvent(body: unknown): ResendFeedbackEvent | null {
	if (typeof body !== 'object' || body === null) return null;
	const { type, data } = body as { type?: unknown; data?: unknown };
	const kind =
		type === 'email.bounced' ? 'bounce' : type === 'email.complained' ? 'complaint' : null;
	if (!kind) return null;
	if (typeof data !== 'object' || data === null) return null;
	const { to, email_id: providerId } = data as { to?: unknown; email_id?: unknown };
	const list = Array.isArray(to) ? to : typeof to === 'string' ? [to] : [];
	const emails = list
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (emails.length === 0) return null;
	return { kind, emails, providerId: typeof providerId === 'string' ? providerId : null };
}
