import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { createEmailSender, type EmailSender } from '../email/service.ts';
import { emailLog } from '../email/schema.ts';
import { hasConsent } from './consent.ts';
import { subscribers } from './schema.ts';
import {
	confirmSubscriber,
	listSubscribers,
	requestNewsletterSignup,
	revokeConsentsByEmail,
	subscribersCsv,
	unsubscribeByToken,
	upsertSubscriber,
	type CrmDeps,
	type NewsletterSignupDeps
} from './service.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh). Email always runs DRY here — sends only ever hit email_log.
let db: Db;
let deps: CrmDeps;
let email: EmailSender;
let signupDeps: NewsletterSignupDeps;

const SECRET = 'crm-spec-secret';

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle')
	});
	deps = { db };
	email = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
	signupDeps = {
		db,
		email,
		secret: SECRET,
		baseUrl: 'https://example.ro',
		siteName: 'Better Sleep'
	};
});

afterAll(async () => {
	await db?.$client.end();
});

describe('upsertSubscriber', () => {
	it('creates a subscriber with timestamped, sourced consents', async () => {
		const result = await upsertSubscriber(deps, {
			email: '  Ana@Example.RO ',
			name: 'Ana',
			grants: { newsletter: true },
			source: 'footer'
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.email).toBe('ana@example.ro');
		expect(result.value.unsubscribeToken).toBeTruthy();
		expect(result.value.consents.newsletter?.granted).toBe(true);
		expect(result.value.consents.newsletter?.source).toBe('footer');
		expect(result.value.consents.newsletter?.at).toBeTruthy();
	});

	it('re-upserting merges consents without duplicating the row', async () => {
		await upsertSubscriber(deps, {
			email: 'merge@example.ro',
			grants: { newsletter: true },
			source: 'footer'
		});
		const second = await upsertSubscriber(deps, {
			email: 'merge@example.ro',
			name: 'Merge',
			grants: { profile_emails: true },
			source: 'quiz:evaluare-somn'
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.name).toBe('Merge');
		expect(hasConsent(second.value.consents, 'newsletter')).toBe(true);
		expect(second.value.consents.newsletter?.source).toBe('footer');
		expect(second.value.consents.profile_emails?.source).toBe('quiz:evaluare-somn');
		const rows = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.email, 'merge@example.ro'));
		expect(rows).toHaveLength(1);
	});

	it('rejects invalid emails', async () => {
		const result = await upsertSubscriber(deps, {
			email: 'not-an-email',
			grants: {},
			source: 'footer'
		});
		expect(result).toEqual({ ok: false, error: 'invalid-email' });
	});
});

describe('newsletter double opt-in', () => {
	it('signup records consent and logs exactly one confirm email (dry-run)', async () => {
		const outcome = await requestNewsletterSignup(signupDeps, {
			email: 'optin@example.ro',
			source: 'footer'
		});
		expect(outcome.ok && outcome.confirm).toBe('dryrun');
		if (!outcome.ok) return;

		const logs = await db.select().from(emailLog).where(eq(emailLog.toEmail, 'optin@example.ro'));
		expect(logs).toHaveLength(1);
		expect(logs[0].template).toBe('newsletter-confirm');
		expect(logs[0].status).toBe('dryrun');
		// The dry-run recorded a working confirm URL.
		const data = logs[0].data as { confirmUrl: string };
		expect(data.confirmUrl).toContain('https://example.ro/newsletter/confirm/');

		// The link from the email confirms the subscriber exactly once.
		const token = data.confirmUrl.split('/newsletter/confirm/')[1];
		const confirmed = await confirmSubscriber(deps, SECRET, token);
		expect(confirmed.ok && !confirmed.already).toBe(true);
		const again = await confirmSubscriber(deps, SECRET, token);
		expect(again.ok && again.already).toBe(true);
	});

	it('an already-confirmed subscriber gets no new confirm email', async () => {
		await requestNewsletterSignup(signupDeps, { email: 'twice@example.ro', source: 'footer' });
		const logs = await db.select().from(emailLog).where(eq(emailLog.toEmail, 'twice@example.ro'));
		const data = logs[0].data as { confirmUrl: string };
		await confirmSubscriber(deps, SECRET, data.confirmUrl.split('/newsletter/confirm/')[1]);

		const after = await requestNewsletterSignup(signupDeps, {
			email: 'twice@example.ro',
			source: 'footer'
		});
		expect(after.ok && after.confirm).toBe('already-confirmed');
		expect(
			await db.select().from(emailLog).where(eq(emailLog.toEmail, 'twice@example.ro'))
		).toHaveLength(1);
	});

	it('rejects tampered and garbage confirm tokens', async () => {
		expect((await confirmSubscriber(deps, SECRET, 'garbage')).ok).toBe(false);
		const outcome = await requestNewsletterSignup(signupDeps, {
			email: 'tamper@example.ro',
			source: 'footer'
		});
		if (!outcome.ok) throw new Error('signup failed');
		const logs = await db.select().from(emailLog).where(eq(emailLog.toEmail, 'tamper@example.ro'));
		const token = (logs[0].data as { confirmUrl: string }).confirmUrl.split(
			'/newsletter/confirm/'
		)[1];
		const wrongSecret = await confirmSubscriber(deps, 'other-secret', token);
		expect(wrongSecret.ok).toBe(false);
	});
});

describe('unsubscribe', () => {
	it('one-click unsubscribe flips all consents with source unsubscribe', async () => {
		const created = await upsertSubscriber(deps, {
			email: 'bye@example.ro',
			grants: { newsletter: true, profile_emails: true },
			source: 'quiz:evaluare-somn'
		});
		if (!created.ok) throw new Error('upsert failed');
		expect(hasConsent(created.value.consents, 'newsletter')).toBe(true);

		const updated = await unsubscribeByToken(deps, created.value.unsubscribeToken);
		expect(updated).not.toBeNull();
		expect(hasConsent(updated!.consents, 'newsletter')).toBe(false);
		expect(hasConsent(updated!.consents, 'profile_emails')).toBe(false);
		expect(updated!.consents.newsletter?.source).toBe('unsubscribe');
	});

	it('an unknown token unsubscribes nobody', async () => {
		expect(await unsubscribeByToken(deps, 'no-such-token')).toBeNull();
	});

	// Audit 2026-09-03 P1: withdrawal kept confirmed_at, so a later re-grant
	// (by anyone who knows the address) was mailable without double opt-in.
	it('withdrawal clears confirmed_at; a re-grant needs a fresh double opt-in (mailable before the fix)', async () => {
		const first = await requestNewsletterSignup(signupDeps, {
			email: 'again@example.ro',
			source: 'footer'
		});
		if (!first.ok) throw new Error('signup failed');
		const logsBefore = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.toEmail, 'again@example.ro'));
		const token = (logsBefore[0].data as { confirmUrl: string }).confirmUrl.split(
			'/newsletter/confirm/'
		)[1];
		const confirmed = await confirmSubscriber(deps, SECRET, token);
		expect(confirmed.ok).toBe(true);

		const withdrawn = await unsubscribeByToken(deps, first.subscriber.unsubscribeToken);
		expect(withdrawn?.confirmedAt).toBeNull();

		// Re-submitting the form: a NEW confirm email, and not mailable until confirmed.
		const second = await requestNewsletterSignup(signupDeps, {
			email: 'again@example.ro',
			source: 'footer'
		});
		if (!second.ok) throw new Error('signup failed');
		expect(second.confirm).toBe('dryrun');
		expect(second.subscriber.confirmedAt).toBeNull();
		expect(hasConsent(second.subscriber.consents, 'newsletter')).toBe(true);
		const logsAfter = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.toEmail, 'again@example.ro'));
		expect(logsAfter).toHaveLength(2);
		expect(logsAfter.every((row) => row.template === 'newsletter-confirm')).toBe(true);
	});

	it('revokeConsentsByEmail (bounce/complaint feedback) withdraws like unsubscribe, with its own source', async () => {
		const created = await upsertSubscriber(deps, {
			email: 'Bounce@Example.RO',
			grants: { newsletter: true },
			source: 'footer'
		});
		if (!created.ok) throw new Error('upsert failed');
		await db
			.update(subscribers)
			.set({ confirmedAt: new Date() })
			.where(eq(subscribers.id, created.value.id));

		const revoked = await revokeConsentsByEmail(deps, 'bounce@example.ro', 'bounce');
		expect(revoked?.id).toBe(created.value.id);
		expect(hasConsent(revoked!.consents, 'newsletter')).toBe(false);
		expect(revoked!.consents.newsletter?.source).toBe('bounce');
		expect(revoked!.confirmedAt).toBeNull();
		expect(await revokeConsentsByEmail(deps, 'nobody@example.ro', 'bounce')).toBeNull();
	});
});

describe('consent evidence', () => {
	it('records ip, user agent and the consent text version on the changed record only', async () => {
		const created = await upsertSubscriber(deps, {
			email: 'evidence@example.ro',
			grants: { newsletter: true },
			source: 'footer',
			evidence: {
				ip: '203.0.113.7',
				userAgent: 'Mozilla/5.0 (spec)',
				consentTextVersion: { newsletter: 'newsletter_consent_label@1' }
			}
		});
		if (!created.ok) throw new Error('upsert failed');
		expect(created.value.consents.newsletter).toMatchObject({
			granted: true,
			source: 'footer',
			ip: '203.0.113.7',
			userAgent: 'Mozilla/5.0 (spec)',
			consentTextVersion: 'newsletter_consent_label@1'
		});
		expect(created.value.consents.profile_emails).toBeUndefined();

		// Re-affirming with different evidence is not a change: the original proof stays.
		const again = await upsertSubscriber(deps, {
			email: 'evidence@example.ro',
			grants: { newsletter: true },
			source: 'quiz:x',
			evidence: { ip: '198.51.100.1' }
		});
		if (!again.ok) throw new Error('upsert failed');
		expect(again.value.consents.newsletter?.ip).toBe('203.0.113.7');
	});
});

describe('admin listing + CSV', () => {
	it('searches by email or name', async () => {
		await upsertSubscriber(deps, {
			email: 'cautat@example.ro',
			name: 'George Căutatul',
			grants: {},
			source: 'footer'
		});
		const byEmail = await listSubscribers(deps, { search: 'cautat@' });
		expect(byEmail.map((r) => r.email)).toContain('cautat@example.ro');
		const byName = await listSubscribers(deps, { search: 'George' });
		expect(byName.map((r) => r.email)).toContain('cautat@example.ro');
		const none = await listSubscribers(deps, { search: 'inexistent-xyz' });
		expect(none).toHaveLength(0);
	});

	it('renders consent status and escapes fields in CSV', async () => {
		const created = await upsertSubscriber(deps, {
			email: 'csv@example.ro',
			name: 'Nume, cu "virgulă"',
			grants: { newsletter: true },
			source: 'footer'
		});
		if (!created.ok) throw new Error('upsert failed');
		const csv = subscribersCsv([created.value]);
		const [header, line] = csv.trim().split('\n');
		expect(header).toContain('newsletter_source');
		expect(line).toContain('csv@example.ro');
		// FIX-12 CSV hygiene: BOM for ro-RO Excel; a formula-shaped name is
		// neutralised with a leading apostrophe instead of executing in a cell.
		expect(csv.startsWith('\uFEFF')).toBe(true);
		const hostile = subscribersCsv([
			{ ...created.value, name: '=HYPERLINK("https://evil.example","x")' }
		]);
		expect(hostile.split('\n')[1]).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
		expect(line).toContain('"Nume, cu ""virgulă"""');
		expect(line).toContain('yes');
		expect(line).toContain('footer');
	});
});
