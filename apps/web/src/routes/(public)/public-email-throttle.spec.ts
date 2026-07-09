import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../../lib/db/client.ts';
import { emailLog } from '../../lib/modules/email/schema.ts';
import { windowStart } from '../../lib/server/rate-limit/core.ts';
import {
	PUBLIC_EMAIL_GLOBAL_LIMIT,
	PUBLIC_EMAIL_IP_LIMIT
} from '../../lib/server/rate-limit/public-email.ts';
import { rateLimits } from '../../lib/server/rate-limit/schema.ts';

// Route-level integration (audit security H2): the REAL newsletter and
// quiz-result actions, invoked the way SvelteKit invokes them, must refuse
// with 429 once the per-IP or global email budget is spent. `$env` values are
// a build-time snapshot under vitest, so the app db is redirected to
// TEST_DATABASE_URL by mocking `$lib/db` — everything downstream (routes,
// email sender, quiz funnel deps) resolves its db through that module.
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;

interface EmailActionEvent {
	request: Request;
	params: { slug: string; resultId: string };
	getClientAddress: () => string;
}
let newsletterAction: (event: Omit<EmailActionEvent, 'params'>) => Promise<unknown>;
let quizEmailAction: (event: EmailActionEvent) => Promise<unknown>;

function newsletterEvent(email: string, ip: string): Omit<EmailActionEvent, 'params'> {
	const body = new FormData();
	body.set('email', email);
	body.set('newsletter_consent', 'yes');
	body.set('source', 'throttle-spec');
	return {
		request: new Request('http://localhost/newsletter', { method: 'POST', body }),
		getClientAddress: () => ip
	};
}

function quizEmailEvent(email: string, ip: string): EmailActionEvent {
	const body = new FormData();
	body.set('email', email);
	return {
		request: new Request('http://localhost/quiz/x/rezultat/y', { method: 'POST', body }),
		params: { slug: 'evaluare-somn', resultId: 'no-such-result' },
		getClientAddress: () => ip
	};
}

/** Spend the whole global budget for a scope in one write (current window). */
async function exhaustGlobalBudget(scope: string): Promise<void> {
	const values = {
		key: `${scope}:global`,
		count: PUBLIC_EMAIL_GLOBAL_LIMIT.max,
		prevCount: 0,
		windowStartedAt: windowStart(new Date(), PUBLIC_EMAIL_GLOBAL_LIMIT.windowMs)
	};
	await db
		.insert(rateLimits)
		.values(values)
		.onConflictDoUpdate({ target: rateLimits.key, set: values });
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			'TEST_DATABASE_URL is not set — start the database with `docker compose up -d db` and configure .env'
		);
	}
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') });

	const newsletter = await import('./newsletter/+page.server.ts');
	newsletterAction = newsletter.actions.default as unknown as typeof newsletterAction;
	const quiz = await import('./quiz/[slug]/rezultat/[resultId]/+page.server.ts');
	quizEmailAction = quiz.actions.email as unknown as typeof quizEmailAction;
});

afterAll(async () => {
	await (appDbHolder.db as Db | undefined)?.$client.end();
	await db?.$client.end();
});

describe('newsletter signup throttle', () => {
	it('returns 429 once the per-IP budget is spent; other IPs are unaffected', async () => {
		const ip = '203.0.113.200';
		for (let i = 1; i <= PUBLIC_EMAIL_IP_LIMIT.max; i++) {
			const result = await newsletterAction(newsletterEvent(`victima-${i}@example.com`, ip));
			expect(isActionFailure(result)).toBe(false);
		}
		// The signups above really went through the email pipeline (dry-run log).
		expect((await db.select().from(emailLog)).length).toBeGreaterThan(0);

		const blocked = await newsletterAction(newsletterEvent('victima-11@example.com', ip));
		if (!isActionFailure(blocked)) throw new Error('expected an ActionFailure');
		expect(blocked.status).toBe(429);
		expect(blocked.data).toEqual({ error: 'rate_limited' });

		const other = await newsletterAction(
			newsletterEvent('alt-vizitator@example.com', '203.0.113.201')
		);
		expect(isActionFailure(other)).toBe(false);
	});

	it('trips the global cap: distinct victims from fresh IPs get 429, not email', async () => {
		await exhaustGlobalBudget('newsletter');
		const logBefore = (await db.select().from(emailLog)).length;

		const blocked = await newsletterAction(
			newsletterEvent('victima-noua@example.com', '198.51.100.230')
		);
		if (!isActionFailure(blocked)) throw new Error('expected an ActionFailure');
		expect(blocked.status).toBe(429);
		expect((await db.select().from(emailLog)).length).toBe(logBefore);
	});
});

describe('quiz-result email throttle', () => {
	it('consumes budget before the result lookup and returns 429 past the per-IP cap', async () => {
		const ip = '203.0.113.210';
		// Unknown result id: the handler 404s AFTER the throttle, so every probe
		// still spends a slot — an attacker can't scan for free.
		for (let i = 1; i <= PUBLIC_EMAIL_IP_LIMIT.max; i++) {
			await quizEmailAction(quizEmailEvent(`victima-${i}@example.com`, ip)).then(
				() => {
					throw new Error('expected error(404)');
				},
				(e: unknown) => {
					if (!isHttpError(e)) throw e;
					expect(e.status).toBe(404);
				}
			);
		}

		const blocked = await quizEmailAction(quizEmailEvent('victima-11@example.com', ip));
		if (!isActionFailure(blocked)) throw new Error('expected an ActionFailure');
		expect(blocked.status).toBe(429);
		expect(blocked.data).toEqual({ error: 'rate-limited' });

		// A different visitor still reaches the handler (404 for this fake id).
		await quizEmailAction(quizEmailEvent('ok@example.com', '203.0.113.211')).then(
			() => {
				throw new Error('expected error(404)');
			},
			(e: unknown) => {
				if (!isHttpError(e)) throw e;
				expect(e.status).toBe(404);
			}
		);
	});

	it('trips the global cap across distinct IPs', async () => {
		await exhaustGlobalBudget('quiz-email');
		const blocked = await quizEmailAction(quizEmailEvent('victima@example.com', '198.51.100.240'));
		if (!isActionFailure(blocked)) throw new Error('expected an ActionFailure');
		expect(blocked.status).toBe(429);
	});
});
