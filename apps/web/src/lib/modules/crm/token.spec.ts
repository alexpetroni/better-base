import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from './token.ts';

const SECRET = 'unit-test-secret';
const NOW = new Date('2026-07-09T10:00:00Z');
const nowEpoch = Math.floor(NOW.getTime() / 1000);

describe('signed action tokens', () => {
	it('round-trips valid claims', () => {
		const token = signToken(SECRET, {
			sub: 'sub-1',
			purpose: 'newsletter-confirm',
			exp: nowEpoch + 60
		});
		expect(verifyToken(SECRET, token, 'newsletter-confirm', NOW)).toEqual({
			ok: true,
			sub: 'sub-1'
		});
	});

	it('rejects an expired token (boundary: exp == now)', () => {
		const token = signToken(SECRET, {
			sub: 'sub-1',
			purpose: 'newsletter-confirm',
			exp: nowEpoch
		});
		expect(verifyToken(SECRET, token, 'newsletter-confirm', NOW)).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('rejects a tampered payload', () => {
		const token = signToken(SECRET, {
			sub: 'sub-1',
			purpose: 'newsletter-confirm',
			exp: nowEpoch + 60
		});
		const [, signature] = token.split('.');
		const forged = Buffer.from(
			JSON.stringify({ sub: 'sub-2', purpose: 'newsletter-confirm', exp: nowEpoch + 60 }),
			'utf8'
		).toString('base64url');
		expect(verifyToken(SECRET, `${forged}.${signature}`, 'newsletter-confirm', NOW).ok).toBe(false);
	});

	it('rejects a token signed with a different secret', () => {
		const token = signToken('other-secret', {
			sub: 'sub-1',
			purpose: 'newsletter-confirm',
			exp: nowEpoch + 60
		});
		expect(verifyToken(SECRET, token, 'newsletter-confirm', NOW)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('rejects a mismatched purpose', () => {
		const token = signToken(SECRET, { sub: 'sub-1', purpose: 'other', exp: nowEpoch + 60 });
		expect(verifyToken(SECRET, token, 'newsletter-confirm', NOW)).toEqual({
			ok: false,
			reason: 'purpose'
		});
	});

	it('rejects garbage input without throwing', () => {
		expect(verifyToken(SECRET, 'not-a-token', 'newsletter-confirm', NOW).ok).toBe(false);
		expect(verifyToken(SECRET, 'a.b', 'newsletter-confirm', NOW).ok).toBe(false);
		expect(verifyToken(SECRET, '', 'newsletter-confirm', NOW).ok).toBe(false);
	});
});
