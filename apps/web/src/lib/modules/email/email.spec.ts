import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { createResendTransport } from './resend.ts';
import { emailLog } from './schema.ts';
import {
	createEmailSender,
	EMAIL_SENDING_STALE_MS,
	shouldSkipResend,
	type EmailMessage
} from './service.ts';
import { renderEmailTemplate } from './templates.ts';

/** A fetch whose request never completes, but that honors its abort signal. */
const hangingFetch: typeof fetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
	});

describe('email templates', () => {
	it('renders the quiz-result template with ro copy and the result link', () => {
		const rendered = renderEmailTemplate('quiz-result', {
			siteName: 'Better Sleep',
			quizTitle: 'Evaluarea somnului',
			score: 12,
			maxScore: 24,
			bandLabel: 'Semne de atenție',
			advice: 'Câteva obiceiuri de corectat.',
			resultUrl: 'https://example.ro/quiz/x/rezultat/1'
		});
		expect(rendered.subject).toContain('Evaluarea somnului');
		expect(rendered.html).toContain('12 din 24');
		expect(rendered.html).toContain('https://example.ro/quiz/x/rezultat/1');
		expect(rendered.text).toContain('Semne de atenție');
		expect(rendered.text).toContain('https://example.ro/quiz/x/rezultat/1');
	});

	it('omits the max score when it is unknown', () => {
		const rendered = renderEmailTemplate('quiz-result', {
			siteName: 'S',
			quizTitle: 'Q',
			score: 7,
			maxScore: null,
			bandLabel: 'B',
			advice: 'A',
			resultUrl: 'https://x'
		});
		expect(rendered.html).toContain('<strong>7</strong>');
		expect(rendered.text).toContain('Scor: 7\n');
	});

	it('renders the nurture template with the mandatory unsubscribe link in html AND text', () => {
		const rendered = renderEmailTemplate('nurture', {
			siteName: 'Better Sleep',
			subject: 'Bine ai venit & spor',
			paragraphs: ['Primul <paragraf>.', 'Al doilea.'],
			cta: { label: 'Fă testul', url: 'https://example.ro/quiz/evaluare-somn' },
			unsubscribeUrl: 'https://example.ro/unsubscribe/tok-123'
		});
		expect(rendered.subject).toBe('Bine ai venit & spor');
		expect(rendered.html).toContain('Primul &lt;paragraf&gt;.');
		expect(rendered.html).toContain('https://example.ro/quiz/evaluare-somn');
		// Marketing mail: the unsubscribe link is not optional.
		expect(rendered.html).toContain('https://example.ro/unsubscribe/tok-123');
		expect(rendered.text).toContain(
			'Dezabonează-te oricând: https://example.ro/unsubscribe/tok-123'
		);
		expect(rendered.text).toContain('Fă testul: https://example.ro/quiz/evaluare-somn');
	});

	it('the nurture template asks for RFC 8058 List-Unsubscribe headers; transactional templates do not', () => {
		const nurture = renderEmailTemplate('nurture', {
			siteName: 'S',
			subject: 'Sub',
			paragraphs: ['P'],
			unsubscribeUrl: 'https://example.ro/unsubscribe/tok-123'
		});
		expect(nurture.headers).toEqual({
			'List-Unsubscribe': '<https://example.ro/unsubscribe/tok-123>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
		});
		const confirm = renderEmailTemplate('newsletter-confirm', {
			siteName: 'S',
			confirmUrl: 'https://example.ro/c'
		});
		expect(confirm.headers).toBeUndefined();
	});

	it('escapes HTML in interpolated data', () => {
		const rendered = renderEmailTemplate('newsletter-confirm', {
			siteName: '<script>alert(1)</script>',
			confirmUrl: 'https://example.ro/confirm?a=1&b="2"'
		});
		expect(rendered.html).not.toContain('<script>');
		expect(rendered.html).toContain('&lt;script&gt;');
		expect(rendered.html).toContain('&amp;b=&quot;2&quot;');
	});

	it('renders the order confirmation with integer-cent formatting and escaping', () => {
		const rendered = renderEmailTemplate('order-confirmation', {
			siteName: 'Better Sleep',
			orderId: 'order-1',
			items: [
				{ name: 'Mască <b>de somn</b>', qty: 2, priceCents: 4990 },
				{ name: 'Ceai de seară', qty: 1, priceCents: 3450 }
			],
			totalCents: 13430,
			currency: 'ron'
		});
		expect(rendered.subject).toContain('Better Sleep');
		// Line totals (qty × unit) and the grand total, formatted from bani.
		expect(rendered.html).toContain('99,80 lei');
		expect(rendered.html).toContain('134,30 lei');
		expect(rendered.text).toContain('34,50 lei');
		expect(rendered.html).not.toContain('<b>de somn</b>');
		expect(rendered.html).toContain('Mască &lt;b&gt;de somn&lt;/b&gt;');
	});
});

describe('shouldSkipResend', () => {
	const now = new Date('2026-09-05T10:00:00Z');
	const row = (status: 'sent' | 'dryrun' | 'sending' | 'error', ageMs = 0) => ({
		status,
		updatedAt: new Date(now.getTime() - ageMs)
	});

	it('treats delivered rows as final in both modes', () => {
		expect(shouldSkipResend(row('sent'), { dryRun: true, now })).toBe(true);
		expect(shouldSkipResend(row('sent'), { dryRun: false, now })).toBe(true);
	});

	it('treats a dry-run record as final only while the sender runs dry (audit: not a delivery)', () => {
		expect(shouldSkipResend(row('dryrun'), { dryRun: true, now })).toBe(true);
		expect(shouldSkipResend(row('dryrun'), { dryRun: false, now })).toBe(false);
	});

	it('treats an in-flight claim as final until it goes stale', () => {
		expect(shouldSkipResend(row('sending'), { dryRun: false, now })).toBe(true);
		expect(
			shouldSkipResend(row('sending', EMAIL_SENDING_STALE_MS - 1), { dryRun: false, now })
		).toBe(true);
		expect(shouldSkipResend(row('sending', EMAIL_SENDING_STALE_MS), { dryRun: false, now })).toBe(
			false
		);
	});

	it('allows retrying failed rows', () => {
		expect(shouldSkipResend(row('error'), { dryRun: false, now })).toBe(false);
		expect(shouldSkipResend(row('error'), { dryRun: true, now })).toBe(false);
	});
});

// Audit Theme C (resilience #3): the Resend call must be bounded — a hung
// socket used to pin the awaiting request forever (the shop webhook awaits
// the send inline).
describe('resend transport request shape', () => {
	it('forwards the template headers to Resend', async () => {
		const fetchFn = vi.fn(async () => Response.json({ id: 're_1' }));
		const transport = createResendTransport('re_key_not_real', fetchFn as typeof fetch);
		await transport.send({
			from: 'a@b.ro',
			to: 'x@y.ro',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			headers: { 'List-Unsubscribe': '<https://example.ro/unsubscribe/t>' }
		});
		const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
		expect(body.headers).toEqual({ 'List-Unsubscribe': '<https://example.ro/unsubscribe/t>' });
	});
});

describe('resend transport timeout', () => {
	it('rejects when the API call exceeds the timeout instead of hanging (hung before the fix)', async () => {
		const transport = createResendTransport('re_key_not_real', hangingFetch, 50);
		await expect(
			transport.send({
				from: 'a@b.ro',
				to: 'x@y.ro',
				subject: 's',
				html: '<p>h</p>',
				text: 't'
			})
		).rejects.toThrow(/timeout/i);
	}, 3_000);
});

// Integration: the sender against the compose Postgres (TEST_DATABASE_URL,
// reset + re-migrated fresh). The transport is ALWAYS a fake here — this spec
// also proves the wrapper never touches it in dry-run mode.
describe('sendEmail idempotency (integration)', () => {
	let db: Db;

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
	});

	afterAll(async () => {
		await db?.$client.end();
	});

	const input = (key: string) =>
		({
			to: 'test@example.com',
			template: 'newsletter-confirm',
			data: { siteName: 'Better Sleep', confirmUrl: 'https://example.ro/c/t' },
			idempotencyKey: key
		}) as const;

	function fakeTransport(impl?: (message: EmailMessage) => Promise<{ providerId: string }>) {
		return { send: vi.fn(impl ?? (async () => ({ providerId: 'prov-1' }))) };
	}

	async function rowsFor(key: string) {
		return db.select().from(emailLog).where(eq(emailLog.idempotencyKey, key));
	}

	it('lowercases the recipient in the log row and toward the transport (GDPR erase match)', async () => {
		const transport = fakeTransport();
		const sender = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });

		const outcome = await sender.send({ ...input('mixed-to-1'), to: 'MiXed.Case@Example.RO' });
		expect(outcome.status).toBe('sent');
		expect(transport.send.mock.calls[0][0].to).toBe('mixed.case@example.ro');
		const rows = await rowsFor('mixed-to-1');
		expect(rows[0].toEmail).toBe('mixed.case@example.ro');
	});

	it('dry-run records exactly one log row and NEVER calls the transport', async () => {
		const transport = fakeTransport();
		const sender = createEmailSender({ db, dryRun: true, from: 'a@b.ro', transport });

		const first = await sender.send(input('dry-1'));
		const second = await sender.send(input('dry-1'));

		expect(first.status).toBe('dryrun');
		expect(second.status).toBe('skipped');
		expect(transport.send).not.toHaveBeenCalled();
		const rows = await rowsFor('dry-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('dryrun');
		expect(rows[0].subject).toContain('Better Sleep');
	});

	it('concurrent sends with the same key collapse to one log row', async () => {
		const sender = createEmailSender({ db, dryRun: true, from: 'a@b.ro' });
		const outcomes = await Promise.all([
			sender.send(input('race-1')),
			sender.send(input('race-1')),
			sender.send(input('race-1'))
		]);
		expect(outcomes.filter((o) => o.status === 'dryrun')).toHaveLength(1);
		expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(2);
		expect(await rowsFor('race-1')).toHaveLength(1);
	});

	it('real mode sends once through the transport, then skips', async () => {
		const transport = fakeTransport();
		const sender = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });

		const first = await sender.send(input('real-1'));
		const second = await sender.send(input('real-1'));

		expect(first.status).toBe('sent');
		expect(second.status).toBe('skipped');
		expect(transport.send).toHaveBeenCalledTimes(1);
		const rows = await rowsFor('real-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('sent');
		expect(rows[0].providerId).toBe('prov-1');
	});

	it('a failed delivery is recorded and may be retried, still with one row', async () => {
		const transport = fakeTransport(async () => {
			throw new Error('boom');
		});
		const failing = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });
		const failed = await failing.send(input('retry-1'));
		expect(failed.status).toBe('error');
		expect((await rowsFor('retry-1'))[0].status).toBe('error');

		const working = createEmailSender({
			db,
			dryRun: false,
			from: 'a@b.ro',
			transport: fakeTransport()
		});
		const retried = await working.send(input('retry-1'));
		expect(retried.status).toBe('sent');
		const rows = await rowsFor('retry-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('sent');
		expect(rows[0].error).toBeNull();
	});

	it('missing transport in real mode records an error instead of throwing', async () => {
		const sender = createEmailSender({ db, dryRun: false, from: 'a@b.ro' });
		const outcome = await sender.send(input('no-transport-1'));
		expect(outcome.status).toBe('error');
		expect((await rowsFor('no-transport-1'))[0].status).toBe('error');
	});

	it('records the template headers on the log row and hands them to the transport', async () => {
		const transport = fakeTransport();
		const sender = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });
		const nurture = {
			to: 'test@example.com',
			template: 'nurture',
			data: {
				siteName: 'S',
				subject: 'Sub',
				paragraphs: ['P'],
				unsubscribeUrl: 'https://example.ro/unsubscribe/tok-h'
			},
			idempotencyKey: 'headers-1'
		} as const;
		expect((await sender.send(nurture)).status).toBe('sent');
		const expected = {
			'List-Unsubscribe': '<https://example.ro/unsubscribe/tok-h>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
		};
		expect(transport.send.mock.calls[0][0].headers).toEqual(expected);
		expect((await rowsFor('headers-1'))[0].headers).toEqual(expected);

		// The dry-run record carries them too (the pre-launch soak shows what would go out).
		const dry = createEmailSender({ db, dryRun: true, from: 'a@b.ro' });
		await dry.send({ ...nurture, idempotencyKey: 'headers-dry-1' });
		expect((await rowsFor('headers-dry-1'))[0].headers).toEqual(expected);
	});

	// Audit 2026-09-03 P1 "Email, CRM & nurture": `dryrun` and `sending` rows
	// were final forever. The documented dry-run soak (EMAIL_DRYRUN=true until
	// DNS is verified) burned every confirm/nurture key it touched — after the
	// flip to live the same key came back `skipped` and nothing went out.
	it('a key recorded under dry-run is delivered once the sender runs live (skipped before the fix)', async () => {
		const dry = createEmailSender({ db, dryRun: true, from: 'a@b.ro' });
		expect((await dry.send(input('soak-1'))).status).toBe('dryrun');

		const transport = fakeTransport();
		const live = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });
		const outcome = await live.send(input('soak-1'));
		expect(outcome.status).toBe('sent');
		expect(transport.send).toHaveBeenCalledTimes(1);
		const rows = await rowsFor('soak-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('sent');

		// …and a later dry-run pass over a DELIVERED key still never re-sends.
		expect((await dry.send(input('soak-1'))).status).toBe('skipped');
		expect((await rowsFor('soak-1'))[0].status).toBe('sent');
	});

	// A serverless kill between the `sending` claim and the transport left the
	// row stuck forever: no retry could ever reclaim it.
	it('a `sending` row older than the staleness window is re-sent exactly once under two concurrent callers', async () => {
		await db.insert(emailLog).values({
			id: 'stale-sending-1',
			idempotencyKey: 'stale-1',
			toEmail: 'test@example.com',
			template: 'newsletter-confirm',
			subject: 's',
			data: {},
			status: 'sending',
			createdAt: new Date(Date.now() - 11 * 60 * 1000),
			updatedAt: new Date(Date.now() - 11 * 60 * 1000)
		});
		const transport = fakeTransport();
		const sender = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });
		const outcomes = await Promise.all([sender.send(input('stale-1')), sender.send(input('stale-1'))]);
		expect(outcomes.map((o) => o.status).sort()).toEqual(['sent', 'skipped']);
		expect(transport.send).toHaveBeenCalledTimes(1);
		const rows = await rowsFor('stale-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('sent');
	});

	it('a FRESH `sending` row (delivery in flight elsewhere) is not re-sent', async () => {
		await db.insert(emailLog).values({
			id: 'fresh-sending-1',
			idempotencyKey: 'fresh-1',
			toEmail: 'test@example.com',
			template: 'newsletter-confirm',
			subject: 's',
			data: {},
			status: 'sending'
		});
		const transport = fakeTransport();
		const sender = createEmailSender({ db, dryRun: false, from: 'a@b.ro', transport });
		expect((await sender.send(input('fresh-1'))).status).toBe('skipped');
		expect(transport.send).not.toHaveBeenCalled();
		expect((await rowsFor('fresh-1'))[0].status).toBe('sending');
	});

	it('a hung Resend socket becomes a retryable error row, not a pinned request (hung before the fix)', async () => {
		const sender = createEmailSender({
			db,
			dryRun: false,
			from: 'a@b.ro',
			transport: createResendTransport('re_key_not_real', hangingFetch, 50)
		});
		const outcome = await sender.send(input('hang-1'));
		expect(outcome.status).toBe('error');
		const [row] = await rowsFor('hang-1');
		expect(row.status).toBe('error');
		expect(row.error).toMatch(/timeout/i);
	}, 3_000);
});
