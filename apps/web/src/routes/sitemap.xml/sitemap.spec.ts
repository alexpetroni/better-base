import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../lib/db/client.ts';
import { seedPillars } from '../../lib/db/seed.ts';
import { createPage } from '../../lib/modules/pages/service.ts';
import { createProduct, updateProduct } from '../../lib/modules/shop/service.ts';
import type { FormConfig } from 'formcomp';
import { users } from '../../lib/modules/auth/schema.ts';
import type { ScoringConfig } from '../../lib/modules/quiz/scoring.ts';
import { SLEEP_QUIZ_SEED } from '../../lib/modules/quiz/seed-quiz.ts';
import { createQuiz, publishQuiz, updateQuiz } from '../../lib/modules/quiz/service.ts';

const USER_ID = 'sitemap-spec-user';

// Regression (audit frontend #7): the sitemap listed only static paths and
// published articles — products and CMS pages were invisible to crawlers.
// Runs the REAL route handler against TEST_DATABASE_URL; `$env` values are a
// build-time snapshot under vitest, so `$lib/db` is mocked to redirect.
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
vi.mock('$lib/server/site', async () => {
	const { resolveSiteConfig } = await import('../../lib/config/index.ts');
	const site = resolveSiteConfig('sleep');
	return { getSite: () => site };
});

let db: Db;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') });
	await seedPillars(db, ['somn', 'nutritie']);
	await db.insert(users).values({ id: USER_ID, name: 'Sitemap', email: 'sitemap@example.com' });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('sitemap.xml', () => {
	it('lists active products and CMS pages, but not drafts', async () => {
		const created = await createProduct({ db }, { name: 'Mască de somn sitemap' });
		if (!created.ok) throw new Error(created.error);
		const activated = await updateProduct({ db }, created.value.id, {
			priceCents: 4990,
			status: 'active',
			pillarSlugs: ['somn']
		});
		if (!activated.ok) throw new Error(activated.error);

		const draft = await createProduct({ db }, { name: 'Produs draft sitemap' });
		if (!draft.ok) throw new Error(draft.error);

		const page = await createPage({ db }, { title: 'Pagina de test sitemap' });
		if (!page.ok) throw new Error(page.error);

		const { GET } = await import('./+server.ts');
		const res = await GET({} as never);
		expect(res.headers.get('content-type')).toContain('application/xml');
		const body = await res.text();

		expect(body).toContain(`/magazin</loc>`);
		expect(body).toContain(`/magazin/${activated.value.slug}</loc>`);
		expect(body).toContain(`/pagini/${page.value.slug}</loc>`);
		// Product/page entries carry a lastmod.
		expect(body).toMatch(
			new RegExp(`/magazin/${activated.value.slug}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}T`)
		);
		// Draft products stay out.
		expect(body).not.toContain(`/magazin/${draft.value.slug}</loc>`);
	});

	// FIX-15 (audit P1): quizzes were absent from the sitemap altogether.
	it('lists published quizzes tagged to an active pillar, with lastmod', async () => {
		const live = await quizWith('Chestionar somn sitemap', 'somn', true);
		const draft = await quizWith('Chestionar draft sitemap', 'somn', false);
		const foreign = await quizWith('Chestionar nutriție sitemap', 'nutritie', true);

		const { GET } = await import('./+server.ts');
		const body = await (await GET({} as never)).text();

		expect(body).toMatch(new RegExp(`/quiz/${live}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}T`));
		expect(body).not.toContain(`/quiz/${draft}</loc>`);
		expect(body).not.toContain(`/quiz/${foreign}</loc>`);
	});
});

async function quizWith(title: string, pillarSlug: string, publish: boolean): Promise<string> {
	const created = await createQuiz({ db }, { title, createdBy: USER_ID });
	if (!created.ok) throw new Error(created.error);
	const updated = await updateQuiz({ db }, created.value.id, {
		formSchema: SLEEP_QUIZ_SEED.formSchema as unknown as FormConfig,
		scoring: SLEEP_QUIZ_SEED.scoring as unknown as ScoringConfig,
		pillarSlug
	});
	if (!updated.ok) throw new Error(updated.error);
	if (publish) {
		const published = await publishQuiz({ db }, created.value.id);
		if (!published.ok) throw new Error(published.detail);
	}
	return updated.value.slug;
}
