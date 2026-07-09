// Seeds the pillars table for the active SITE_ID, plus demo content
// (articles, quiz, products incl. placeholder images). Run via `pnpm db:seed`.
import { config } from 'dotenv';
import path from 'node:path';
import { resolveSiteConfig } from '../src/lib/config/index.ts';
import { createDb } from '../src/lib/db/client.ts';
import {
	seedDemoArticles,
	seedDemoProducts,
	seedDemoQuiz,
	seedPillars
} from '../src/lib/db/seed.ts';
import { storageConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

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
await db.$client.end();
