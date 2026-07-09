import { describe, expect, it } from 'vitest';
import { applyConsents, hasConsent, revokeAllConsents, type Consents } from './consent.ts';

const NOW = new Date('2026-07-09T10:00:00Z');
const LATER = new Date('2026-07-10T12:00:00Z');

describe('applyConsents', () => {
	it('stamps every granted consent with timestamp and source', () => {
		const next = applyConsents({}, { newsletter: true }, 'quiz:evaluare-somn', NOW);
		expect(next.newsletter).toEqual({
			granted: true,
			at: NOW.toISOString(),
			source: 'quiz:evaluare-somn'
		});
		expect(next.profile_emails).toBeUndefined();
	});

	it('leaves absent keys untouched — an unticked checkbox never revokes', () => {
		const current: Consents = {
			newsletter: { granted: true, at: NOW.toISOString(), source: 'footer' }
		};
		const next = applyConsents(current, { profile_emails: true }, 'quiz:x', LATER);
		expect(next.newsletter).toEqual(current.newsletter);
		expect(next.profile_emails?.granted).toBe(true);
	});

	it('records explicit revocation with the new timestamp and source', () => {
		const current: Consents = {
			newsletter: { granted: true, at: NOW.toISOString(), source: 'footer' }
		};
		const next = applyConsents(current, { newsletter: false }, 'unsubscribe', LATER);
		expect(next.newsletter).toEqual({
			granted: false,
			at: LATER.toISOString(),
			source: 'unsubscribe'
		});
	});

	it('re-affirming an unchanged consent keeps the original record', () => {
		const current: Consents = {
			newsletter: { granted: true, at: NOW.toISOString(), source: 'footer' }
		};
		const next = applyConsents(current, { newsletter: true }, 'quiz:x', LATER);
		expect(next.newsletter).toEqual(current.newsletter);
	});

	it('does not mutate the input object', () => {
		const current: Consents = {
			newsletter: { granted: true, at: NOW.toISOString(), source: 'footer' }
		};
		applyConsents(current, { newsletter: false }, 'unsubscribe', LATER);
		expect(current.newsletter?.granted).toBe(true);
	});
});

describe('revokeAllConsents / hasConsent', () => {
	it('revokes every key with source unsubscribe', () => {
		const current: Consents = {
			newsletter: { granted: true, at: NOW.toISOString(), source: 'footer' },
			profile_emails: { granted: true, at: NOW.toISOString(), source: 'quiz:x' }
		};
		const next = revokeAllConsents(current, LATER);
		expect(hasConsent(next, 'newsletter')).toBe(false);
		expect(hasConsent(next, 'profile_emails')).toBe(false);
		expect(next.newsletter?.source).toBe('unsubscribe');
		expect(next.newsletter?.at).toBe(LATER.toISOString());
	});

	it('hasConsent is false for missing records', () => {
		expect(hasConsent({}, 'newsletter')).toBe(false);
	});
});
