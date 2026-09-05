import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { parseResendEvent, verifyResendWebhook } from './webhook.ts';

// Resend signs webhooks with the Svix scheme: `whsec_<base64 key>`, signed
// content `${svix-id}.${svix-timestamp}.${body}`, HMAC-SHA256, base64, sent
// as `svix-signature: v1,<sig> [v1,<sig> …]`, with a ±5 min timestamp window.

const SECRET = 'whsec_' + Buffer.from('resend-spec-key-0123456789abcdef').toString('base64');
const NOW = new Date('2026-09-05T10:00:00Z');
const BODY = JSON.stringify({ type: 'email.bounced', data: { to: ['a@b.ro'] } });

function sign(secret: string, id: string, timestamp: string, body: string): string {
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
	return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function headers(
	over: Partial<Record<'svix-id' | 'svix-timestamp' | 'svix-signature', string>> = {}
) {
	const id = 'msg_1';
	const timestamp = String(Math.floor(NOW.getTime() / 1000));
	return new Headers({
		'svix-id': id,
		'svix-timestamp': timestamp,
		'svix-signature': `v1,${sign(SECRET, id, timestamp, BODY)}`,
		...over
	});
}

describe('verifyResendWebhook', () => {
	it('accepts a correctly signed payload inside the timestamp window', () => {
		expect(verifyResendWebhook(BODY, headers(), SECRET, NOW)).toBe(true);
	});

	it('accepts when ANY of several v1 signatures matches (key rotation)', () => {
		const id = 'msg_1';
		const timestamp = String(Math.floor(NOW.getTime() / 1000));
		const good = sign(SECRET, id, timestamp, BODY);
		const h = headers({ 'svix-signature': `v1,${Buffer.alloc(32).toString('base64')} v1,${good}` });
		expect(verifyResendWebhook(BODY, h, SECRET, NOW)).toBe(true);
	});

	it('rejects a wrong secret, a tampered body and a missing header', () => {
		const other = 'whsec_' + Buffer.from('another-key-another-key-00000000').toString('base64');
		expect(verifyResendWebhook(BODY, headers(), other, NOW)).toBe(false);
		expect(verifyResendWebhook(BODY.replace('a@b.ro', 'z@b.ro'), headers(), SECRET, NOW)).toBe(
			false
		);
		const noSig = headers();
		noSig.delete('svix-signature');
		expect(verifyResendWebhook(BODY, noSig, SECRET, NOW)).toBe(false);
	});

	it('rejects a timestamp outside the ±5 minute window (replay)', () => {
		const id = 'msg_1';
		const stale = String(Math.floor(NOW.getTime() / 1000) - 6 * 60);
		const h = headers({
			'svix-timestamp': stale,
			'svix-signature': `v1,${sign(SECRET, id, stale, BODY)}`
		});
		expect(verifyResendWebhook(BODY, h, SECRET, NOW)).toBe(false);
	});
});

describe('parseResendEvent', () => {
	it('extracts the recipients of bounce and complaint events, lowercased', () => {
		expect(
			parseResendEvent({
				type: 'email.bounced',
				data: { email_id: 'e1', to: ['A@B.ro', 'c@d.ro'] }
			})
		).toEqual({ kind: 'bounce', emails: ['a@b.ro', 'c@d.ro'], providerId: 'e1' });
		expect(parseResendEvent({ type: 'email.complained', data: { to: 'x@y.ro' } })).toEqual({
			kind: 'complaint',
			emails: ['x@y.ro'],
			providerId: null
		});
	});

	it('ignores every other event type and malformed payloads', () => {
		expect(parseResendEvent({ type: 'email.delivered', data: { to: ['a@b.ro'] } })).toBeNull();
		expect(parseResendEvent({ type: 'email.bounced' })).toBeNull();
		expect(parseResendEvent(null)).toBeNull();
		expect(parseResendEvent('nope')).toBeNull();
	});
});
