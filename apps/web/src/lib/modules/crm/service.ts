import { desc, eq, ilike, or } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { EmailSender, SendEmailOutcome } from '../email/service.ts';
import { applyConsents, hasConsent, revokeAllConsents, type ConsentChanges } from './consent.ts';
import { subscribers, type SubscriberRow } from './schema.ts';
import { signToken, verifyToken } from './token.ts';

/**
 * Subscriber services. Framework-free ({ db } passed in). The double opt-in
 * confirm link uses a stateless signed token; the one-click unsubscribe link
 * uses the per-subscriber token stored on the row (it must never expire).
 */

export interface CrmDeps {
	db: Db;
}

export type CrmResult<T> = { ok: true; value: T } | { ok: false; error: 'invalid-email' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased/trimmed email, or null when it is not plausibly an address. */
export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	return EMAIL_RE.test(email) ? email : null;
}

export interface UpsertSubscriberInput {
	email: string;
	name?: string;
	locale?: string;
	/** Only explicit intents: an absent key never flips existing consent. */
	grants: ConsentChanges;
	/** Recorded on every consent change, e.g. `quiz:evaluare-somn`, `footer`. */
	source: string;
}

export async function upsertSubscriber(
	deps: CrmDeps,
	input: UpsertSubscriberInput
): Promise<CrmResult<SubscriberRow>> {
	const email = normalizeEmail(input.email);
	if (!email) return { ok: false, error: 'invalid-email' };
	const now = new Date();

	const [existing] = await deps.db.select().from(subscribers).where(eq(subscribers.email, email));
	if (existing) {
		const [updated] = await deps.db
			.update(subscribers)
			.set({
				name: input.name?.trim() || existing.name,
				locale: input.locale ?? existing.locale,
				consents: applyConsents(existing.consents, input.grants, input.source, now),
				updatedAt: now
			})
			.where(eq(subscribers.id, existing.id))
			.returning();
		return { ok: true, value: updated };
	}

	const [inserted] = await deps.db
		.insert(subscribers)
		.values({
			id: crypto.randomUUID(),
			email,
			name: input.name?.trim() || null,
			locale: input.locale ?? 'ro',
			consents: applyConsents({}, input.grants, input.source, now),
			unsubscribeToken: crypto.randomUUID()
		})
		.onConflictDoNothing({ target: subscribers.email })
		.returning();
	// Lost a concurrent insert race: apply the change as an update instead.
	if (!inserted) return upsertSubscriber(deps, input);
	return { ok: true, value: inserted };
}

export async function getSubscriber(deps: CrmDeps, id: string): Promise<SubscriberRow | null> {
	const [row] = await deps.db.select().from(subscribers).where(eq(subscribers.id, id));
	return row ?? null;
}

export const NEWSLETTER_CONFIRM_PURPOSE = 'newsletter-confirm';
export const CONFIRM_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

export interface NewsletterSignupDeps extends CrmDeps {
	email: EmailSender;
	/** HMAC secret for confirm tokens (the app wires BETTER_AUTH_SECRET). */
	secret: string;
	/** Public origin for links in emails, e.g. https://bettersleep.ro */
	baseUrl: string;
	siteName: string;
}

export interface NewsletterSignupInput {
	email: string;
	name?: string;
	locale?: string;
	source: string;
}

export type NewsletterSignupOutcome =
	| {
			ok: true;
			subscriber: SubscriberRow;
			confirm: 'already-confirmed' | SendEmailOutcome['status'];
	  }
	| { ok: false; error: 'invalid-email' };

/**
 * Send the double opt-in confirm email for a subscriber with (unconfirmed)
 * newsletter consent. The idempotency key includes the consent timestamp —
 * stable across handler retries (applyConsents never re-stamps an unchanged
 * grant), fresh when consent is newly (re-)granted.
 */
export async function sendNewsletterConfirmEmail(
	deps: NewsletterSignupDeps,
	subscriber: SubscriberRow
): Promise<SendEmailOutcome['status'] | 'already-confirmed'> {
	if (subscriber.confirmedAt) return 'already-confirmed';
	const token = signToken(deps.secret, {
		sub: subscriber.id,
		purpose: NEWSLETTER_CONFIRM_PURPOSE,
		exp: Math.floor(Date.now() / 1000) + CONFIRM_TOKEN_TTL_SECONDS
	});
	const outcome = await deps.email.send({
		to: subscriber.email,
		template: 'newsletter-confirm',
		data: {
			siteName: deps.siteName,
			confirmUrl: `${deps.baseUrl}/newsletter/confirm/${token}`
		},
		idempotencyKey: `newsletter-confirm:${subscriber.id}:${subscriber.consents.newsletter?.at ?? ''}`
	});
	return outcome.status;
}

/**
 * Newsletter opt-in: record consent (timestamped, sourced), then start double
 * opt-in with a signed confirm link — unless this address already confirmed.
 */
export async function requestNewsletterSignup(
	deps: NewsletterSignupDeps,
	input: NewsletterSignupInput
): Promise<NewsletterSignupOutcome> {
	const upserted = await upsertSubscriber(deps, {
		...input,
		grants: { newsletter: true }
	});
	if (!upserted.ok) return upserted;
	const subscriber = upserted.value;
	const confirm = await sendNewsletterConfirmEmail(deps, subscriber);
	return { ok: true, subscriber, confirm };
}

export type ConfirmOutcome =
	| { ok: true; subscriber: SubscriberRow; already: boolean }
	| { ok: false; error: 'invalid-token' | 'expired' | 'not-found' };

/** Double opt-in confirm: verify the signed link and stamp confirmed_at once. */
export async function confirmSubscriber(
	deps: CrmDeps,
	secret: string,
	token: string,
	now = new Date()
): Promise<ConfirmOutcome> {
	const verified = verifyToken(secret, token, NEWSLETTER_CONFIRM_PURPOSE, now);
	if (!verified.ok) {
		return { ok: false, error: verified.reason === 'expired' ? 'expired' : 'invalid-token' };
	}
	const existing = await getSubscriber(deps, verified.sub);
	if (!existing) return { ok: false, error: 'not-found' };
	if (existing.confirmedAt) return { ok: true, subscriber: existing, already: true };
	const [updated] = await deps.db
		.update(subscribers)
		.set({ confirmedAt: now, updatedAt: now })
		.where(eq(subscribers.id, existing.id))
		.returning();
	return { ok: true, subscriber: updated, already: false };
}

/** One-click unsubscribe by the stored (non-expiring) token: revokes ALL consents. */
export async function unsubscribeByToken(
	deps: CrmDeps,
	token: string
): Promise<SubscriberRow | null> {
	const [existing] = await deps.db
		.select()
		.from(subscribers)
		.where(eq(subscribers.unsubscribeToken, token));
	if (!existing) return null;
	const now = new Date();
	const [updated] = await deps.db
		.update(subscribers)
		.set({ consents: revokeAllConsents(existing.consents, now), updatedAt: now })
		.where(eq(subscribers.id, existing.id))
		.returning();
	return updated;
}

/** Admin listing: newest first, optional case-insensitive email/name search. */
export async function listSubscribers(
	deps: CrmDeps,
	opts: { search?: string } = {}
): Promise<SubscriberRow[]> {
	const term = opts.search?.trim();
	return deps.db
		.select()
		.from(subscribers)
		.where(
			term
				? or(ilike(subscribers.email, `%${term}%`), ilike(subscribers.name, `%${term}%`))
				: undefined
		)
		.orderBy(desc(subscribers.createdAt), desc(subscribers.id));
}

function csvField(value: string | null): string {
	const text = value ?? '';
	return /[",\n\r;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV export for the admin screen. Pure. */
export function subscribersCsv(rows: SubscriberRow[]): string {
	const header = [
		'email',
		'name',
		'locale',
		'newsletter',
		'newsletter_at',
		'newsletter_source',
		'profile_emails',
		'profile_emails_at',
		'profile_emails_source',
		'confirmed_at',
		'created_at'
	];
	const lines = rows.map((row) => {
		const newsletter = row.consents.newsletter;
		const profile = row.consents.profile_emails;
		return [
			row.email,
			row.name,
			row.locale,
			hasConsent(row.consents, 'newsletter') ? 'yes' : 'no',
			newsletter?.at ?? '',
			newsletter?.source ?? '',
			hasConsent(row.consents, 'profile_emails') ? 'yes' : 'no',
			profile?.at ?? '',
			profile?.source ?? '',
			row.confirmedAt?.toISOString() ?? '',
			row.createdAt.toISOString()
		]
			.map(csvField)
			.join(',');
	});
	return [header.join(','), ...lines].join('\n') + '\n';
}
