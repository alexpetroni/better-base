import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { emailLog } from './schema.ts';
import { createEmailSender, shouldSkipResend, type EmailMessage } from './service.ts';
import { renderEmailTemplate } from './templates.ts';

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

	it('escapes HTML in interpolated data', () => {
		const rendered = renderEmailTemplate('newsletter-confirm', {
			siteName: '<script>alert(1)</script>',
			confirmUrl: 'https://example.ro/confirm?a=1&b="2"'
		});
		expect(rendered.html).not.toContain('<script>');
		expect(rendered.html).toContain('&lt;script&gt;');
		expect(rendered.html).toContain('&amp;b=&quot;2&quot;');
	});
});

describe('shouldSkipResend', () => {
	it('treats delivered, dry-run and in-flight rows as final', () => {
		expect(shouldSkipResend('sent')).toBe(true);
		expect(shouldSkipResend('dryrun')).toBe(true);
		expect(shouldSkipResend('sending')).toBe(true);
	});

	it('allows retrying failed rows', () => {
		expect(shouldSkipResend('error')).toBe(false);
	});
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
});
