import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { pages } from './schema.ts';
import { createPage, ensurePage, getPageBySlug, listPages, updatePage } from './service.ts';
import { DEFAULT_PAGES, PRIVACY_PAGE_SLUG, TERMS_PAGE_SLUG } from './seed-pages.ts';

let db: Db;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('pages service', () => {
	it('seeds the default legal pages once and NEVER overwrites edits', async () => {
		for (const page of DEFAULT_PAGES) {
			expect(await ensurePage({ db }, page)).toBe('created');
		}
		// Editor customizes the privacy policy…
		const privacy = await getPageBySlug({ db }, PRIVACY_PAGE_SLUG);
		expect(privacy).not.toBeNull();
		await updatePage({ db }, privacy!.id, {
			title: privacy!.title,
			bodyMd: 'Text legal revizuit de jurist.',
			seoDescription: null
		});
		// …then a re-seed must keep the edit.
		for (const page of DEFAULT_PAGES) {
			expect(await ensurePage({ db }, page)).toBe('exists');
		}
		const after = await getPageBySlug({ db }, PRIVACY_PAGE_SLUG);
		expect(after!.bodyMd).toBe('Text legal revizuit de jurist.');
		expect(await getPageBySlug({ db }, TERMS_PAGE_SLUG)).not.toBeNull();
	});

	it('creates pages with unique ro slugs and rejects empty titles', async () => {
		const first = await createPage({ db }, { title: 'Despre livrări' });
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.value.slug).toBe('despre-livrari');
		const second = await createPage({ db }, { title: 'Despre livrări' });
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.value.slug).toBe('despre-livrari-2');
		expect(await createPage({ db }, { title: '   ' })).toEqual({
			ok: false,
			error: 'invalid-title'
		});
	});

	it('updates title/body/seo and stamps updatedAt', async () => {
		const created = await createPage({ db }, { title: 'Pagina de test' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const result = await updatePage({ db }, created.value.id, {
			title: 'Pagina de test v2',
			bodyMd: '## Salut',
			seoDescription: 'desc'
		});
		expect(result.ok).toBe(true);
		const [row] = await db.select().from(pages).where(eq(pages.id, created.value.id));
		expect(row.title).toBe('Pagina de test v2');
		expect(row.bodyMd).toBe('## Salut');
		expect(row.seoDescription).toBe('desc');
		expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
		expect(
			await updatePage({ db }, 'missing-id', { title: 'X', bodyMd: '', seoDescription: null })
		).toEqual({
			ok: false,
			error: 'not-found'
		});
		const pageList = await listPages({ db });
		expect(pageList.length).toBeGreaterThanOrEqual(4);
	});
});
