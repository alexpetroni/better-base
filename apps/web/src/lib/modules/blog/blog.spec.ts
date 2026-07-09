import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { withDbFault } from '../../../../tests/helpers/db-fault.ts';
import { resolveSiteConfig } from '../../config/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { seedPillars } from '../../db/seed.ts';
import { users } from '../auth/schema.ts';
import type { ImgproxyConfig } from '../media/imgproxy.ts';
import { media } from '../media/schema.ts';
import { articlesMediaReferenceCheck } from './media-ref.ts';
import { renderArticleHtml } from './render.ts';
import { articlePillars, type ArticleRow } from './schema.ts';
import {
	createArticle,
	getBySlug,
	listArticles,
	listPublished,
	listPublishedForSitemap,
	publishArticle,
	unpublishArticle,
	updateArticle,
	type BlogDeps
} from './service.ts';

// Integration test against the compose Postgres (TEST_DATABASE_URL, reset +
// re-migrated fresh). All 9 canonical pillars are seeded — the same rows a
// better-life database has — so site-visibility is asserted against the REAL
// site configs' pillar lists.
let db: Db;
let deps: BlogDeps;

const USER_ID = 'blog-spec-user';
const sleepPillars = resolveSiteConfig('sleep').pillars;
const lifePillars = resolveSiteConfig('life').pillars;

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
	await seedPillars(db, lifePillars);
	await db.insert(users).values({ id: USER_ID, name: 'Blog Spec', email: 'blog-spec@example.com' });
	deps = { db };
});

afterAll(async () => {
	await db?.$client.end();
});

async function makeArticle(title: string, pillarSlugs: string[] = []): Promise<ArticleRow> {
	const created = await createArticle(deps, { title, createdBy: USER_ID });
	if (!created.ok) throw new Error(`createArticle failed: ${created.error}`);
	if (pillarSlugs.length) {
		const updated = await updateArticle(deps, created.value.id, { pillarSlugs });
		if (!updated.ok) throw new Error(`updateArticle failed: ${updated.error}`);
		return updated.value;
	}
	return created.value;
}

describe('slug uniqueness against the database', () => {
	it('suffixes colliding slugs from identical titles', async () => {
		const a = await makeArticle('Rutina de seară');
		const b = await makeArticle('Rutina de seară');
		const c = await makeArticle('Rutina de seară');
		expect(a.slug).toBe('rutina-de-seara');
		expect(b.slug).toBe('rutina-de-seara-2');
		expect(c.slug).toBe('rutina-de-seara-3');
	});

	it('normalizes and deduplicates an explicitly edited slug', async () => {
		const a = await makeArticle('Igiena somnului');
		const edited = await updateArticle(deps, a.id, { slug: 'Igienă & Somn' });
		expect(edited.ok && edited.value.slug).toBe('igiena-somn');

		const b = await makeArticle('Alt articol despre igienă');
		const collided = await updateArticle(deps, b.id, { slug: 'igiena-somn' });
		expect(collided.ok && collided.value.slug).toBe('igiena-somn-2');

		// Re-saving your own slug must not suffix it.
		const same = await updateArticle(deps, a.id, { slug: 'igiena-somn' });
		expect(same.ok && same.value.slug).toBe('igiena-somn');

		const invalid = await updateArticle(deps, a.id, { slug: '???' });
		expect(!invalid.ok && invalid.error).toBe('invalid-slug');
	});
});

describe('publish lifecycle', () => {
	it('drafts are invisible publicly; publishing stamps publishedAt once', async () => {
		const draft = await makeArticle('Ciclurile somnului', ['somn']);
		expect(draft.status).toBe('draft');
		expect(await getBySlug(deps, draft.slug)).toBeNull();
		expect((await getBySlug(deps, draft.slug, { includeDrafts: true }))?.article.id).toBe(draft.id);

		const published = await publishArticle(deps, draft.id);
		if (!published.ok) throw new Error(published.error);
		const firstPublishedAt = published.value.publishedAt;
		expect(firstPublishedAt).toBeInstanceOf(Date);
		expect((await getBySlug(deps, draft.slug))?.article.id).toBe(draft.id);

		const unpublished = await unpublishArticle(deps, draft.id);
		expect(unpublished.ok && unpublished.value.status).toBe('draft');
		expect(await getBySlug(deps, draft.slug)).toBeNull();

		const republished = await publishArticle(deps, draft.id);
		expect(republished.ok && republished.value.publishedAt?.getTime()).toBe(
			firstPublishedAt?.getTime()
		);
	});
});

describe('pillar visibility follows the site config', () => {
	it('rejects tagging to a pillar slug that does not exist', async () => {
		const a = await makeArticle('Articol cu pilon inexistent');
		const result = await updateArticle(deps, a.id, { pillarSlugs: ['inexistent'] });
		expect(!result.ok && result.error).toBe('unknown-pillar');
	});

	it('retagging is atomic: a failed re-insert keeps the old pillar tags (audit Theme B)', async () => {
		const a = await makeArticle('Retag atomic', ['somn']);
		const [somn] = await db.select().from(pillars).where(eq(pillars.slug, 'somn'));

		const { db: faultyDb, fault } = withDbFault(db, 'insert', articlePillars);
		fault.arm();
		await expect(
			updateArticle({ db: faultyDb }, a.id, { pillarSlugs: ['nutritie'] })
		).rejects.toThrow('injected insert fault');
		expect(fault.hits).toBe(1);

		// The delete must have rolled back with the failed insert — otherwise the
		// article silently loses all tags and disappears from every site.
		const joins = await db.select().from(articlePillars).where(eq(articlePillars.articleId, a.id));
		expect(joins.map((j) => j.pillarId)).toEqual([somn.id]);
	});

	it('somn-tagged articles appear on BOTH sites; foreign/untagged ones only where active', async () => {
		const somnArticle = await makeArticle('Somnul profund explicat', ['somn']);
		const nutritieArticle = await makeArticle('Micul dejun ideal', ['nutritie']);
		const untagged = await makeArticle('Articol fără pilon');
		for (const a of [somnArticle, nutritieArticle, untagged]) {
			const r = await publishArticle(deps, a.id);
			expect(r.ok).toBe(true);
		}

		const onSleep = await listPublished(deps, { pillarSlugs: sleepPillars });
		const sleepSlugs = onSleep.items.map((i) => i.article.slug);
		expect(sleepSlugs).toContain(somnArticle.slug);
		// Tagged only to a pillar that is NOT active on better-sleep → invisible there.
		expect(sleepSlugs).not.toContain(nutritieArticle.slug);
		expect(sleepSlugs).not.toContain(untagged.slug);

		const onLife = await listPublished(deps, { pillarSlugs: lifePillars });
		const lifeSlugs = onLife.items.map((i) => i.article.slug);
		// An article tagged only `somn` appears on better-life (somn is active there).
		expect(lifeSlugs).toContain(somnArticle.slug);
		expect(lifeSlugs).toContain(nutritieArticle.slug);
		// Tagged to no active pillar of the site → does not appear.
		expect(lifeSlugs).not.toContain(untagged.slug);

		expect((await listPublished(deps, { pillarSlugs: [] })).items).toHaveLength(0);
	});

	it('paginates newest-first and reports totals', async () => {
		for (let i = 1; i <= 4; i++) {
			const a = await makeArticle(`Serie paginare ${i}`, ['somn']);
			await publishArticle(deps, a.id);
		}
		const page1 = await listPublished(deps, { pillarSlugs: sleepPillars, page: 1, pageSize: 3 });
		const page2 = await listPublished(deps, { pillarSlugs: sleepPillars, page: 2, pageSize: 3 });
		expect(page1.items.length).toBe(3);
		expect(page1.pageCount).toBe(Math.ceil(page1.total / 3));
		expect(page2.items.length).toBeGreaterThanOrEqual(1);
		const ids = new Set([...page1.items, ...page2.items].map((i) => i.article.id));
		expect(ids.size).toBe(page1.items.length + page2.items.length);
	});
});

describe('admin listing and sitemap', () => {
	it('filters by status and searches title/slug case-insensitively', async () => {
		const a = await makeArticle('Melatonina și lumina albastră');
		const all = await listArticles(deps, { search: 'melatonina' });
		expect(all.some((r) => r.id === a.id)).toBe(true);
		const drafts = await listArticles(deps, { status: 'draft', search: 'MELATONINA' });
		expect(drafts.some((r) => r.id === a.id)).toBe(true);
		const published = await listArticles(deps, { status: 'published', search: 'melatonina' });
		expect(published.some((r) => r.id === a.id)).toBe(false);
	});

	it('sitemap listing contains published, site-visible slugs only', async () => {
		const pub = await makeArticle('Pentru sitemap', ['somn']);
		await publishArticle(deps, pub.id);
		const draft = await makeArticle('Draft pentru sitemap', ['somn']);
		const entries = await listPublishedForSitemap(deps, sleepPillars);
		const slugs = entries.map((e) => e.slug);
		expect(slugs).toContain(pub.slug);
		expect(slugs).not.toContain(draft.slug);
	});
});

describe('media integration', () => {
	const cfg: ImgproxyConfig = {
		baseUrl: 'http://img.test',
		key: 'aa',
		salt: 'bb',
		bucket: 'bkt'
	};

	async function insertImage(id: string, key: string) {
		await db.insert(media).values({
			id,
			kind: 'image',
			key,
			filename: 'p.png',
			mime: 'image/png',
			size: 100,
			width: 1200,
			height: 800,
			alt: 'Poza de test',
			createdBy: USER_ID
		});
	}

	it('renderArticleHtml resolves refs by id and key, and video rows to iframes', async () => {
		await insertImage('m-img', 'uploads/x/poza.png');
		await db.insert(media).values({
			id: 'm-vid',
			kind: 'video-embed',
			videoProvider: 'youtube',
			videoExternalId: 'abc123',
			alt: 'Video test',
			createdBy: USER_ID
		});

		const html = await renderArticleHtml(
			deps,
			cfg,
			'![prin id](media:m-img)\n\n![prin cheie](media:uploads/x/poza.png)\n\n![video](media:m-vid)\n\n![lipsa](media:nope)'
		);
		expect(html.match(/<picture>/g)).toHaveLength(2);
		expect(html).toContain('http://img.test/');
		expect(html).toContain('https://www.youtube-nocookie.com/embed/abc123');
		expect(html).not.toContain('media:nope');
	});

	it('reference check reports covers and body references, by id and key', async () => {
		await insertImage('m-cover', 'uploads/x/cover.png');
		await insertImage('m-body', 'uploads/x/body.png');
		await insertImage('m-free', 'uploads/x/free.png');

		const a = await makeArticle('Articol cu media');
		await updateArticle(deps, a.id, {
			coverMediaId: 'm-cover',
			bodyMd: 'text ![x](media:uploads/x/body.png)'
		});

		expect(await articlesMediaReferenceCheck.isReferenced(db, 'm-cover')).toBe(true);
		expect(await articlesMediaReferenceCheck.isReferenced(db, 'm-body')).toBe(true);
		expect(await articlesMediaReferenceCheck.isReferenced(db, 'm-free')).toBe(false);
	});
});
