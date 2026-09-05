import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { seedPillars } from '../../../lib/db/seed.ts';
import { users } from '../../../lib/modules/auth/schema.ts';
import { createArticle, publishArticle, updateArticle } from '../../../lib/modules/blog/service.ts';

// FIX-15 (audit P1 blog visibility, P2 `?page=`): runs the REAL route loads
// against TEST_DATABASE_URL as the sleep site (`somn` only). `$env` values are
// a build-time snapshot under vitest, so `$lib/db` is mocked to redirect.
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
const USER_ID = 'blog-routes-user';

async function publishedArticle(title: string, pillarSlugs: string[]): Promise<string> {
	const created = await createArticle({ db }, { title, createdBy: USER_ID });
	if (!created.ok) throw new Error(created.error);
	if (pillarSlugs.length) {
		const tagged = await updateArticle({ db }, created.value.id, { pillarSlugs });
		if (!tagged.ok) throw new Error(tagged.error);
	}
	const published = await publishArticle({ db }, created.value.id);
	if (!published.ok) throw new Error(published.error);
	return published.value.slug;
}

function listLoad(query: string) {
	return import('./+page.server.ts').then(({ load }) =>
		load({ url: new URL(`https://sleep.test/blog${query}`) } as never)
	);
}

function detailLoad(slug: string) {
	return import('./[slug]/+page.server.ts').then(({ load }) => load({ params: { slug } } as never));
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
		.values({ id: USER_ID, name: 'Blog Routes', email: 'blog-routes@example.com' });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('/blog/[slug]', () => {
	it('404s for a published article whose only pillar is inactive on this site', async () => {
		const foreign = await publishedArticle('Articol de nutriție', ['nutritie']);
		await expect(detailLoad(foreign)).rejects.toMatchObject({ status: 404 });
	});

	it('serves a published article tagged to an active pillar', async () => {
		const somn = await publishedArticle('Articol despre somn', ['somn']);
		const data = await detailLoad(somn);
		expect(data.canonical).toContain(`/blog/${somn}`);
	});
});

describe('/blog?page=', () => {
	it('treats a non-integer page as page 1 instead of failing', async () => {
		await expect(listLoad('?page=1.5')).resolves.toMatchObject({ page: 1 });
		await expect(listLoad('?page=abc')).resolves.toMatchObject({ page: 1 });
		await expect(listLoad('?page=-3')).resolves.toMatchObject({ page: 1 });
		await expect(listLoad('?page=1e400')).resolves.toMatchObject({ page: 1 });
	});

	it('404s past the last page, but page 1 always renders', async () => {
		await expect(listLoad('?page=999')).rejects.toMatchObject({ status: 404 });
		const first = await listLoad('');
		expect(first.page).toBe(1);
		expect(first.pageCount).toBeGreaterThanOrEqual(1);
	});
});
