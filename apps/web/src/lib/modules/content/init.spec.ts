import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { seedPillars } from '../../db/seed.ts';
import { articles } from '../blog/schema.ts';
import { storageConfigFromEnv } from '../media/env.ts';
import { media } from '../media/schema.ts';
import { createStorage } from '../media/storage.ts';
import { products } from '../shop/schema.ts';
import { CONTENT_BUNDLE_VERSION, type ContentBundle } from './bundle.ts';
import type { ContentDeps } from './export.ts';
import { contentDirsFor, importContentDirs } from './init.ts';

// Integration test for the initial-content directory loader against the
// compose Postgres + MinIO, using throwaway bundle directories in tmp.

const FIXTURE = path.resolve(import.meta.dirname, '../../../../tests/fixtures/test-image.png');

let db: Db;
let deps: ContentDeps;
let base: string;
let imageBytes: Buffer;

function articleBundle(slug: string, title: string, pillarSlugs = ['somn']): ContentBundle {
	return {
		version: CONTENT_BUNDLE_VERSION,
		type: 'article',
		pillars: pillarSlugs,
		media: [],
		article: {
			slug,
			title,
			excerpt: 'excerpt',
			bodyMd: '# body',
			coverMediaId: null,
			status: 'published',
			publishedAt: '2026-06-01T08:00:00.000Z',
			seoTitle: null,
			seoDescription: null
		}
	};
}

/** A product carrying its cover image bytes — exercises the media path. */
function productBundle(slug: string, mediaId: string, key: string): ContentBundle {
	return {
		version: CONTENT_BUNDLE_VERSION,
		type: 'product',
		pillars: ['somn'],
		media: [
			{
				id: mediaId,
				kind: 'image',
				key,
				filename: 'cover.png',
				mime: 'image/png',
				size: imageBytes.byteLength,
				width: null,
				height: null,
				alt: 'cover',
				blurhash: null,
				videoProvider: null,
				videoExternalId: null,
				dataBase64: imageBytes.toString('base64')
			}
		],
		product: {
			slug,
			name: 'Pernă',
			descriptionMd: 'desc',
			priceCents: 9900,
			currency: 'RON',
			status: 'active',
			coverMediaId: mediaId,
			gallery: [],
			stock: 5
		}
	};
}

async function writeBundle(dir: string, name: string, bundle: ContentBundle | string) {
	await mkdir(dir, { recursive: true });
	const body = typeof bundle === 'string' ? bundle : JSON.stringify(bundle, null, '\t');
	await writeFile(path.join(dir, name), body, 'utf8');
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	const storageCfg = storageConfigFromEnv(process.env);
	if (!storageCfg.endpoint) {
		throw new Error('S3_* env vars are not set — start `docker compose up -d`');
	}

	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	// Only `somn` — like the better-sleep site: `nutritie` bundles must be refused.
	await seedPillars(db, ['somn']);

	const storage = createStorage(storageCfg);
	await storage.ensureBucket();
	deps = { db, storage };
	imageBytes = await readFile(FIXTURE);
});

afterAll(async () => {
	if (base) await rm(base, { recursive: true, force: true });
	await db.$client.end();
});

beforeEach(async () => {
	if (base) await rm(base, { recursive: true, force: true });
	base = await mkdtemp(path.join(tmpdir(), 'content-init-'));
});

describe('contentDirsFor', () => {
	it('puts common before the site directory', () => {
		expect(contentDirsFor('/repo/content', 'sleep')).toEqual([
			'/repo/content/common',
			'/repo/content/sleep'
		]);
	});
});

describe('importContentDirs', () => {
	it('skips missing directories without failing', async () => {
		const summary = await importContentDirs(deps, contentDirsFor(base, 'sleep'));
		expect(summary).toMatchObject({ dirs: [], results: [], imported: 0, failed: 0 });
	});

	it('imports common then site bundles, in filename order, ignoring non-json', async () => {
		const dirs = contentDirsFor(base, 'sleep');
		await writeBundle(dirs[0], '020-b.json', articleBundle('b-common', 'B'));
		await writeBundle(dirs[0], '010-a.json', articleBundle('a-common', 'A'));
		await writeBundle(dirs[0], 'notes.md', 'not a bundle');
		await writeBundle(dirs[1], '010-c.json', articleBundle('c-site', 'C'));

		const summary = await importContentDirs(deps, dirs);

		expect(summary.failed).toBe(0);
		expect(summary.imported).toBe(3);
		expect(summary.dirs).toEqual(dirs);
		expect(summary.results.map((r) => path.basename(r.file))).toEqual([
			'010-a.json',
			'020-b.json',
			'010-c.json'
		]);
		const rows = await db
			.select()
			.from(articles)
			.where(inArray(articles.slug, ['a-common', 'b-common', 'c-site']));
		expect(rows.map((r) => r.slug).sort()).toEqual(['a-common', 'b-common', 'c-site']);
	});

	it('lets a site bundle update a common one of the same slug', async () => {
		const dirs = contentDirsFor(base, 'sleep');
		await writeBundle(dirs[0], 'a.json', articleBundle('shared', 'Common title'));
		await writeBundle(dirs[1], 'a.json', articleBundle('shared', 'Site title'));

		const summary = await importContentDirs(deps, dirs);

		expect(summary.results.map((r) => (r.ok ? r.summary.action : r.error))).toEqual([
			'created',
			'updated'
		]);
		const [row] = await db.select().from(articles).where(eq(articles.slug, 'shared'));
		expect(row.title).toBe('Site title');
	});

	it('is idempotent: re-running creates no duplicate rows or media', async () => {
		const dirs = contentDirsFor(base, 'sleep');
		await writeBundle(dirs[0], 'article.json', articleBundle('idem', 'Idem'));
		await writeBundle(
			dirs[0],
			'product.json',
			productBundle('perna-idem', '11111111-1111-4111-8111-111111111111', 'seed/perna-idem.png')
		);

		const first = await importContentDirs(deps, dirs);
		expect(first).toMatchObject({ imported: 2, failed: 0 });
		const second = await importContentDirs(deps, dirs);
		expect(second).toMatchObject({ imported: 2, failed: 0 });

		expect(second.results.every((r) => r.ok && r.summary.action === 'updated')).toBe(true);
		expect((await db.select().from(articles).where(eq(articles.slug, 'idem'))).length).toBe(1);
		expect((await db.select().from(products).where(eq(products.slug, 'perna-idem'))).length).toBe(
			1
		);
		expect((await db.select().from(media).where(eq(media.key, 'seed/perna-idem.png'))).length).toBe(
			1
		);
		// Second pass reuses the uploaded object instead of re-uploading it.
		const productRun = second.results.find((r) => path.basename(r.file) === 'product.json');
		expect(productRun).toMatchObject({ ok: true, summary: { mediaCreated: 0, mediaReused: 1 } });
	});

	it('reports a broken file and keeps importing the rest', async () => {
		const dirs = contentDirsFor(base, 'sleep');
		await writeBundle(dirs[0], '010-broken.json', '{ not json');
		// Valid JSON, invalid bundle: right version, no type/pillars/media.
		await writeBundle(dirs[0], '020-malformed.json', `{ "version": ${CONTENT_BUNDLE_VERSION} }`);
		await writeBundle(dirs[0], '030-good.json', articleBundle('survivor', 'Survivor'));

		const summary = await importContentDirs(deps, dirs);

		expect(summary).toMatchObject({ imported: 1, failed: 2 });
		expect(summary.results[0].ok).toBe(false);
		expect(summary.results[1]).toMatchObject({ ok: false });
		expect(summary.results[2]).toMatchObject({ ok: true, type: 'article' });
		const [row] = await db.select().from(articles).where(eq(articles.slug, 'survivor'));
		expect(row.title).toBe('Survivor');
	});

	it('refuses a bundle whose pillars are all inactive on this site', async () => {
		const dirs = contentDirsFor(base, 'sleep');
		await writeBundle(dirs[0], 'nutrition.json', articleBundle('nutritie-x', 'N', ['nutritie']));

		const summary = await importContentDirs(deps, dirs);

		expect(summary.failed).toBe(1);
		expect(summary.results[0]).toMatchObject({ ok: false });
		expect(summary.results[0].ok === false && summary.results[0].error).toContain(
			'missing-pillars'
		);
		expect((await db.select().from(articles).where(eq(articles.slug, 'nutritie-x'))).length).toBe(
			0
		);
	});

	it('imports an off-site bundle untagged when allowUntagged is set', async () => {
		const dirs = contentDirsFor(base, 'sleep');
		await writeBundle(dirs[0], 'nutrition.json', articleBundle('nutritie-y', 'N', ['nutritie']));

		const summary = await importContentDirs(deps, dirs, { allowUntagged: true });

		expect(summary).toMatchObject({ imported: 1, failed: 0 });
		expect(summary.results[0]).toMatchObject({
			ok: true,
			summary: { pillarsTagged: [], pillarsSkipped: ['nutritie'] }
		});
	});

	it('leaves the pillar table untouched', async () => {
		expect((await db.select().from(pillars)).map((p) => p.slug)).toEqual(['somn']);
	});
});
