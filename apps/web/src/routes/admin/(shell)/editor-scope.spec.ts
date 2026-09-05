import { beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { users } from '../../../lib/modules/auth/schema.ts';
import { subscribers } from '../../../lib/modules/crm/schema.ts';
import { pages } from '../../../lib/modules/pages/schema.ts';
import { quizResults, quizzes } from '../../../lib/modules/quiz/schema.ts';
import { createSettingsLoader } from '../../../lib/modules/settings/service.ts';

/**
 * Editor role scoping (audit 2026-09-03, "Auth, GDPR & frontend"):
 * - the quiz editor's results table must not hand SUBSCRIBER EMAILS to the
 *   editor role — that list is customer PII an editor has no business seeing;
 * - the legal pages (terms/privacy/cookies live in the pages section) must
 *   not be rewritable by an editor, POST included, on a REAL row.
 */

const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;

const ADMIN = {
	id: 'scope-admin',
	email: 'scope-admin@example.com',
	name: 'Scope Admin',
	role: 'admin' as const
};
const EDITOR = {
	id: 'scope-editor',
	email: 'scope-editor@example.com',
	name: 'Scope Editor',
	role: 'editor' as const
};

const QUIZ_ID = 'scope-quiz';
const SUBSCRIBER_EMAIL = 'client-pii@example.ro';
const PAGE_ID = 'scope-terms-page';
const PAGE_BODY = 'Textul original al termenilor.';

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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	appDbHolder.db = db;

	await db.insert(users).values([
		{ id: ADMIN.id, name: ADMIN.name, email: ADMIN.email, role: ADMIN.role },
		{ id: EDITOR.id, name: EDITOR.name, email: EDITOR.email, role: EDITOR.role }
	]);
	await db.insert(quizzes).values({ id: QUIZ_ID, slug: 'scope-quiz', title: 'Scope Quiz' });
	const [subscriber] = await db
		.insert(subscribers)
		.values({
			id: 'scope-subscriber',
			email: SUBSCRIBER_EMAIL,
			unsubscribeToken: 'scope-unsub-token'
		})
		.returning();
	await db.insert(quizResults).values({
		id: 'scope-result',
		quizId: QUIZ_ID,
		subscriberId: subscriber.id,
		score: 7,
		profile: {
			score: 7,
			maxScore: 10,
			band: { key: 'mid', min: 5, label: 'Mediu', advice: 'Continuă.' },
			dimensions: []
		}
	});
	await db.insert(pages).values({
		id: PAGE_ID,
		slug: 'termeni-si-conditii',
		title: 'Termeni și condiții',
		bodyMd: PAGE_BODY
	});
});

function locals(user: typeof ADMIN | typeof EDITOR): App.Locals {
	return { user, settings: createSettingsLoader(() => db), requestId: 'spec' };
}

describe('quiz editor results for the editor role', () => {
	async function loadResults(user: typeof ADMIN | typeof EDITOR) {
		const mod = await import('./quizzes/[id]/+page.server.ts');
		const data = (await mod.load({
			params: { id: QUIZ_ID },
			locals: locals(user)
		} as unknown as Parameters<(typeof mod)['load']>[0])) as {
			results: Array<{ result: { id: string }; email: string | null }>;
		};
		return data.results;
	}

	it('shows the claiming subscriber email to an admin', async () => {
		const results = await loadResults(ADMIN);
		expect(results).toHaveLength(1);
		expect(results[0].email).toBe(SUBSCRIBER_EMAIL);
	});

	it('hands an editor the same results with NO email anywhere in the payload', async () => {
		const results = await loadResults(EDITOR);
		expect(results).toHaveLength(1);
		expect(results[0].result.id).toBe('scope-result');
		expect(JSON.stringify(results)).not.toContain(SUBSCRIBER_EMAIL);
	});
});

describe('legal page save for the editor role', () => {
	it('403s an editor POST to a real legal page and leaves the body untouched', async () => {
		const mod = await import('./pages/[id]/+page.server.ts');
		const form = new FormData();
		form.set('title', 'Termeni rescrisi');
		form.set('bodyMd', 'Alt text.');
		try {
			await mod.actions.save({
				request: new Request('http://localhost/admin/pages/x?/save', {
					method: 'POST',
					body: form
				}),
				params: { id: PAGE_ID },
				locals: locals(EDITOR)
			} as unknown as Parameters<(typeof mod)['actions']['save']>[0]);
			expect.fail('expected a thrown 403, but the save ran');
		} catch (e) {
			if (!isHttpError(e, 403)) throw new Error(`expected 403, got: ${String(e)}`, { cause: e });
			expect(e.status).toBe(403);
		}

		const [row] = await db.select().from(pages).where(eq(pages.id, PAGE_ID));
		expect(row.bodyMd).toBe(PAGE_BODY);
		expect(row.title).toBe('Termeni și condiții');
	});
});
