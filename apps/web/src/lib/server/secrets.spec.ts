import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { getChatSecret, signSessionToken, verifySessionToken } from '$lib/modules/chat/server';
import { getTokenSecret, signToken, verifyToken } from '$lib/modules/crm/server';
import { tokenSecretFrom } from './secrets.ts';

describe('tokenSecretFrom', () => {
	it('returns the dedicated TOKEN_SECRET', () => {
		expect(tokenSecretFrom({ TOKEN_SECRET: 'tok', BETTER_AUTH_SECRET: 'auth' })).toBe('tok');
	});

	it('throws a clear message when TOKEN_SECRET is unset', () => {
		expect(() => tokenSecretFrom({ BETTER_AUTH_SECRET: 'auth' })).toThrow(
			/TOKEN_SECRET is not set/
		);
		expect(() => tokenSecretFrom({ TOKEN_SECRET: '' })).toThrow(/TOKEN_SECRET is not set/);
	});

	it('refuses a TOKEN_SECRET equal to BETTER_AUTH_SECRET (the reuse it exists to prevent)', () => {
		expect(() => tokenSecretFrom({ TOKEN_SECRET: 'same', BETTER_AUTH_SECRET: 'same' })).toThrow(
			/must differ from BETTER_AUTH_SECRET/
		);
	});
});

describe('app token-secret wiring (audit L5: one secret must not sign everything)', () => {
	it('consent and chat getters return TOKEN_SECRET, not the auth secret', () => {
		expect(getTokenSecret()).toBe(env.TOKEN_SECRET);
		expect(getChatSecret()).toBe(env.TOKEN_SECRET);
		expect(getTokenSecret()).not.toBe(env.BETTER_AUTH_SECRET);
	});

	it('a consent token signed with the app secret does NOT verify under BETTER_AUTH_SECRET', () => {
		const now = new Date();
		const token = signToken(getTokenSecret(), {
			sub: 'sub-1',
			purpose: 'newsletter-confirm',
			exp: Math.floor(now.getTime() / 1000) + 60
		});
		expect(verifyToken(getTokenSecret(), token, 'newsletter-confirm', now).ok).toBe(true);
		expect(verifyToken(env.BETTER_AUTH_SECRET!, token, 'newsletter-confirm', now)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('a chat session token signed with the app secret does NOT verify under BETTER_AUTH_SECRET', () => {
		const token = signSessionToken(getChatSecret(), 'session-1', 'anon-1');
		expect(verifySessionToken(getChatSecret(), token).ok).toBe(true);
		expect(verifySessionToken(env.BETTER_AUTH_SECRET!, token)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});
});
