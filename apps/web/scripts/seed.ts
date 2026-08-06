// Seeds the pillars table for the active SITE_ID, plus demo content
// (articles, quiz, products incl. placeholder images), then imports the
// initial content bundles from `content/`. Run via `pnpm db:seed`.
import path from 'node:path';
import { loadRootEnv } from './env.ts';
import { resolveSiteConfig } from '../src/lib/config/index.ts';
import { createDb } from '../src/lib/db/client.ts';
import {
	seedDemoArticles,
	seedDemoProducts,
	seedDefaultPages,
	seedDemoQuiz,
	seedPillars
} from '../src/lib/db/seed.ts';
import {
	contentDirsFor,
	formatInitResult,
	importContentDirs
} from '../src/lib/modules/content/init.ts';
import { storageConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';

loadRootEnv();

const site = resolveSiteConfig(process.env.SITE_ID);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const db = createDb(databaseUrl);
const count = await seedPillars(db, site.pillars);
console.log(`Seeded ${count} pillar(s) for site "${site.id}"`);
const articleCount = await seedDemoArticles(db);
console.log(`Seeded ${articleCount} demo article(s)`);
const quizSlug = await seedDemoQuiz(db);
console.log(`Seeded demo quiz "/quiz/${quizSlug}"`);
// Product placeholder images land in storage — needs the compose MinIO up.
const storage = createStorage(storageConfigFromEnv(process.env));
await storage.ensureBucket();
const productCount = await seedDemoProducts(db, storage);
console.log(`Seeded ${productCount} demo product(s)`);
const pageCount = await seedDefaultPages(db);
console.log(`Seeded ${pageCount} default page(s)`);

// Initial content last: importing needs the pillars above to already exist
// (a bundle whose pillars are all missing is refused as invisible).
const contentBase =
	process.env.CONTENT_DIR ?? path.resolve(import.meta.dirname, '../../../content');
const dirs = contentDirsFor(contentBase, site.id);
const init = await importContentDirs({ db, storage }, dirs);
if (init.dirs.length === 0) {
	console.log(`No initial content directories under ${contentBase} — skipped`);
} else {
	console.log(
		`Initial content from ${init.dirs.map((d) => path.relative(contentBase, d) || '.').join(', ')}: ` +
			`${init.imported} imported, ${init.failed} failed`
	);
	for (const result of init.results) console.log(formatInitResult(result));
}

await db.$client.end();
// A broken bundle must not pass silently as a successful seed.
if (init.failed > 0) process.exit(1);
