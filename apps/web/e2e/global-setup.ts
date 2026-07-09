// Runs once before the e2e suite: migrate both site databases, seed the staff
// users the admin tests log in with, and clear rate-limit counters left by a
// previous run (their 15-minute window outlives a test cycle).
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolveSiteConfig } from '../src/lib/config/index.ts';
import { createDb } from '../src/lib/db/client.ts';
import { seedDemoProducts, seedDemoQuiz, seedPillars } from '../src/lib/db/seed.ts';
import { createAuth } from '../src/lib/modules/auth/auth.ts';
import { upsertStaffUser } from '../src/lib/modules/auth/staff.ts';
import { storageConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';
import { E2E_ADMIN, E2E_EDITOR, SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';

export default async function globalSetup() {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error('BETTER_AUTH_SECRET is not set — configure the root .env');

	// A fresh compose stack has no bucket yet (same bootstrap as `pnpm storage:init`).
	const storage = createStorage(storageConfigFromEnv(process.env));
	await storage.ensureBucket();

	for (const siteId of Object.keys(SITE_DB_NAMES) as Array<keyof typeof SITE_DB_NAMES>) {
		const db = createDb(siteDatabaseUrl(siteId));
		try {
			await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../drizzle') });
			// The quiz e2e runs against the seeded pillars + demo quiz (idempotent).
			await seedPillars(db, resolveSiteConfig(siteId).pillars);
			await seedDemoQuiz(db);
			const auth = createAuth({ db, secret });
			await upsertStaffUser(auth, { ...E2E_ADMIN, role: 'admin' });
			await upsertStaffUser(auth, { ...E2E_EDITOR, role: 'editor' });
			await db.execute(sql`delete from login_attempts`);
			// Content is created by the tests themselves; leftovers from a failed
			// earlier run would break slug and filename assumptions. Articles and
			// shop rows go first — they reference media (FKs + delete-refusal
			// checks); order_items reference orders and products.
			await db.execute(sql`delete from articles`);
			await db.execute(sql`delete from order_items`);
			await db.execute(sql`delete from orders`);
			await db.execute(sql`delete from products`);
			await db.execute(sql`delete from media`);
			// Funnel leftovers: results reference subscribers, so they go first.
			await db.execute(sql`delete from quiz_results`);
			await db.execute(sql`delete from subscribers`);
			await db.execute(sql`delete from email_log`);
			// The shop e2e runs against the seeded demo catalog (idempotent; also
			// restores stock levels consumed by earlier webhook simulations).
			await seedDemoProducts(db, storage);
		} finally {
			await db.$client.end();
		}
	}
}
