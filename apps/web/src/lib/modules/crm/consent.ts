/**
 * GDPR consent shaping, pure. Consents are stored as jsonb on the subscriber:
 * each key carries its own granted flag, timestamp and source, so every
 * consent CHANGE is provable. Callers pass only EXPLICIT intents — an
 * unticked checkbox on a later form is a no-op, never a revocation
 * (revocation happens only via unsubscribe or an explicit false).
 */

export const CONSENT_KEYS = ['newsletter', 'profile_emails'] as const;

export type ConsentKey = (typeof CONSENT_KEYS)[number];

export interface ConsentRecord {
	granted: boolean;
	/** ISO timestamp of the change. */
	at: string;
	/** Where the change came from, e.g. `quiz:evaluare-somn`, `footer`, `unsubscribe`. */
	source: string;
}

export type Consents = Partial<Record<ConsentKey, ConsentRecord>>;

/** Only keys present here are touched; `undefined` keys keep their state. */
export type ConsentChanges = Partial<Record<ConsentKey, boolean>>;

export function applyConsents(
	current: Consents,
	changes: ConsentChanges,
	source: string,
	now: Date
): Consents {
	const next: Consents = { ...current };
	for (const key of CONSENT_KEYS) {
		const granted = changes[key];
		if (granted === undefined) continue;
		next[key] = { granted, at: now.toISOString(), source };
	}
	return next;
}

export function hasConsent(consents: Consents, key: ConsentKey): boolean {
	return consents[key]?.granted === true;
}

/** All consents revoked — the one-click unsubscribe shape. */
export function revokeAllConsents(current: Consents, now: Date): Consents {
	const changes: ConsentChanges = {};
	for (const key of CONSENT_KEYS) changes[key] = false;
	return applyConsents(current, changes, 'unsubscribe', now);
}
