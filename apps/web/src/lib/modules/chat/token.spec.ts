import { describe, expect, it } from 'vitest';
import { signSessionToken, verifySessionToken } from './token.ts';

const SECRET = 'chat-spec-secret';
const SESSION = '3c1f4c1e-0000-4000-8000-000000000001';
const ANON = '9a2b3c4d-0000-4000-8000-000000000002';

describe('chat session tokens', () => {
	it('round-trips sign → verify', () => {
		const token = signSessionToken(SECRET, SESSION, ANON);
		expect(verifySessionToken(SECRET, token)).toEqual({
			ok: true,
			sessionId: SESSION,
			anonymousToken: ANON
		});
	});

	it('rejects a token signed with a foreign secret', () => {
		const token = signSessionToken('some-other-secret', SESSION, ANON);
		expect(verifySessionToken(SECRET, token)).toEqual({ ok: false, reason: 'signature' });
	});

	it('rejects a token re-pointed at another session', () => {
		const token = signSessionToken(SECRET, SESSION, ANON);
		const [, anon, sig] = token.split('.');
		const forged = `11111111-0000-4000-8000-000000000009.${anon}.${sig}`;
		expect(verifySessionToken(SECRET, forged)).toEqual({ ok: false, reason: 'signature' });
	});

	it('rejects a tampered signature', () => {
		const token = signSessionToken(SECRET, SESSION, ANON);
		const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
		expect(verifySessionToken(SECRET, tampered).ok).toBe(false);
	});

	it('rejects malformed tokens', () => {
		for (const bad of ['', 'x', 'a.b', 'a..c', '.b.c', 'a.b.c.d']) {
			expect(verifySessionToken(SECRET, bad)).toEqual({ ok: false, reason: 'malformed' });
		}
	});
});
