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
	/**
	 * Where the change came from, e.g. `quiz:evaluare-somn`, `footer`,
	 * `unsubscribe`, `bounce`, `complaint`.
	 */
	source: string;
	/** Proof of a visitor-made change: who (network-wise) agreed, with what client, to which copy. */
	ip?: string;
	userAgent?: string;
	/** The consent copy the visitor saw, as `<message key>@<version>` (CONSENT_TEXT_VERSIONS). */
	consentTextVersion?: string;
}

export type Consents = Partial<Record<ConsentKey, ConsentRecord>>;

/** Only keys present here are touched; `undefined` keys keep their state. */
export type ConsentChanges = Partial<Record<ConsentKey, boolean>>;

/** Evidence recorded on every consent record a visitor's request changes. */
export interface ConsentEvidence {
	ip?: string;
	userAgent?: string;
	/** Per consent key: the copy the visitor agreed to. */
	consentTextVersion?: Partial<Record<ConsentKey, string>>;
}

/**
 * The consent copy currently rendered by the public forms, versioned. Bump
 * the `@n` suffix whenever the corresponding message text changes meaning —
 * the record then proves WHICH wording a visitor agreed to.
 */
export const CONSENT_TEXT_VERSIONS: Record<ConsentKey, string> = {
	newsletter: 'newsletter_consent_label@1',
	profile_emails: 'quiz_consent_profile_label@1'
};

export function applyConsents(
	current: Consents,
	changes: ConsentChanges,
	source: string,
	now: Date,
	evidence?: ConsentEvidence
): Consents {
	const next: Consents = { ...current };
	for (const key of CONSENT_KEYS) {
		const granted = changes[key];
		if (granted === undefined) continue;
		// Re-affirming an unchanged state is not a consent CHANGE: the original
		// record (the proof of when consent was first given) is kept, and
		// retried handlers stay idempotent because the timestamp is stable.
		if (current[key]?.granted === granted) continue;
		const record: ConsentRecord = { granted, at: now.toISOString(), source };
		if (evidence?.ip) record.ip = evidence.ip;
		if (evidence?.userAgent) record.userAgent = evidence.userAgent;
		const version = evidence?.consentTextVersion?.[key];
		if (version) record.consentTextVersion = version;
		next[key] = record;
	}
	return next;
}

export function hasConsent(consents: Consents, key: ConsentKey): boolean {
	return consents[key]?.granted === true;
}

/** All consents revoked — unsubscribe, or a bounce/complaint fed back by the mail provider. */
export function revokeAllConsents(current: Consents, now: Date, source = 'unsubscribe'): Consents {
	const changes: ConsentChanges = {};
	for (const key of CONSENT_KEYS) changes[key] = false;
	return applyConsents(current, changes, source, now);
}
