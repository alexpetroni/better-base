import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FormConfig } from 'formcomp';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { seedPillars } from '../../../lib/db/seed.ts';
import { users } from '../../../lib/modules/auth/schema.ts';
import type { ScoringConfig } from '../../../lib/modules/quiz/scoring.ts';
import { SLEEP_QUIZ_SEED } from '../../../lib/modules/quiz/seed-quiz.ts';
import {
	createQuiz,
	publishQuiz,
	submitQuiz,
	updateQuiz
} from '../../../lib/modules/quiz/service.ts';

// FIX-15 (audit P1: "same for quiz result pages"): the result page checked
// published status but not the pillar, so a result of a quiz that is not
// visible on this site still rendered. Real route loads, sleep site.
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
vi.mock('$lib/server/site', async () => {
	const { resolveSiteConfig } = await import('../../../lib/config/index.ts');
	const site = resolveSiteConfig('sleep');
	return { getSite: () => site };
});

let db: Db;
const USER_ID = 'quiz-routes-user';
const FORM = SLEEP_QUIZ_SEED.formSchema as unknown as FormConfig;
const SCORING = SLEEP_QUIZ_SEED.scoring as unknown as ScoringConfig;

async function resultFor(
	title: string,
	pillarSlug: string
): Promise<{ slug: string; resultId: string }> {
	const created = await createQuiz({ db }, { title, createdBy: USER_ID });
	if (!created.ok) throw new Error(created.error);
	const updated = await updateQuiz({ db }, created.value.id, {
		formSchema: FORM,
		scoring: SCORING,
		pillarSlug
	});
	if (!updated.ok) throw new Error(updated.error);
	const published = await publishQuiz({ db }, created.value.id);
	if (!published.ok) throw new Error(published.detail);
	const submitted = await submitQuiz({ db }, { quizId: created.value.id, answers: [] });
	if (!submitted.ok) throw new Error(submitted.error);
	return { slug: published.value.slug, resultId: submitted.value.id };
}

function resultLoad(slug: string, resultId: string) {
	return import('./[slug]/rezultat/[resultId]/+page.server.ts').then(({ load }) =>
		load({ params: { slug, resultId } } as never)
	);
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	await seedPillars(db, ['somn', 'nutritie']);
	await db
		.insert(users)
		.values({ id: USER_ID, name: 'Quiz Routes', email: 'quiz-routes@example.com' });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('/quiz/[slug]/rezultat/[resultId]', () => {
	it('404s for a result of a quiz whose pillar is inactive on this site', async () => {
		const { slug, resultId } = await resultFor('Chestionar nutriție', 'nutritie');
		await expect(resultLoad(slug, resultId)).rejects.toMatchObject({ status: 404 });
	});

	it('renders a result of a quiz tagged to an active pillar', async () => {
		const { slug, resultId } = await resultFor('Chestionar somn', 'somn');
		const data = await resultLoad(slug, resultId);
		if (!data) throw new Error('load returned nothing');
		expect(data.quizSlug).toBe(slug);
		expect(data.profile.band).toBeDefined();
	});
});
