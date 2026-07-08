// Runs once before the e2e suite: migrate both site databases, seed the staff
// users the admin tests log in with, and clear rate-limit counters left by a
// previous run (their 15-minute window outlives a test cycle).
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/lib/db/client.ts';
import { createAuth } from '../src/lib/modules/auth/auth.ts';
import { upsertStaffUser } from '../src/lib/modules/auth/staff.ts';
import { E2E_ADMIN, E2E_EDITOR, SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';

export default async function globalSetup() {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error('BETTER_AUTH_SECRET is not set — configure the root .env');

	for (const siteId of Object.keys(SITE_DB_NAMES) as Array<keyof typeof SITE_DB_NAMES>) {
		const db = createDb(siteDatabaseUrl(siteId));
		try {
			await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../drizzle') });
			const auth = createAuth({ db, secret });
			await upsertStaffUser(auth, { ...E2E_ADMIN, role: 'admin' });
			await upsertStaffUser(auth, { ...E2E_EDITOR, role: 'editor' });
			await db.execute(sql`delete from login_attempts`);
		} finally {
			await db.$client.end();
		}
	}
}
