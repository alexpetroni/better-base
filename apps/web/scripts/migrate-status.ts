// `pnpm db:status` — print, for the target database, every committed migration
// and whether it is applied. The migrate workflow runs it after `pnpm
// db:migrate` so each CI run logs the exact production migration state; it is
// read-only and safe anywhere. Exits nonzero while migrations are pending
// (like `git diff --exit-code`), so it doubles as a "schema is current" gate.
//
// Prefers DIRECT_DATABASE_URL exactly like drizzle.config.ts: on Neon the
// pooled endpoint runs PgBouncer, and the status check should look at the
// same database the migrator wrote to.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';

loadRootEnv();

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('DIRECT_DATABASE_URL (or DATABASE_URL) is not set');
	process.exit(1);
}

// The committed journal is the source of truth for what SHOULD be applied.
// Drizzle's migration table stores each applied migration's folder timestamp
// (`when` in the journal) as created_at — that, not the hash, maps back to a
// human-readable tag.
const journalPath = path.resolve(import.meta.dirname, '../drizzle/meta/_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
	entries: Array<{ when: number; tag: string }>;
};

const db = createDb(url);
let applied = new Set<number>();
try {
	const result = await db.execute(sql`select created_at from drizzle.__drizzle_migrations`);
	applied = new Set(result.rows.map((row) => Number(row.created_at)));
} catch (err) {
	// 42P01 = relation does not exist: a fresh database, nothing applied yet.
	// Drizzle wraps the driver error, so the code sits on the cause.
	const code =
		(err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
	if (code !== '42P01') throw err;
} finally {
	await db.$client.end();
}

for (const entry of journal.entries) {
	console.log(`${applied.has(entry.when) ? 'applied' : 'PENDING'}  ${entry.tag}`);
}
const pending = journal.entries.filter((entry) => !applied.has(entry.when)).length;
if (pending > 0) {
	console.error(`db:status — ${pending} of ${journal.entries.length} migration(s) PENDING`);
	process.exit(1);
}
console.log(`db:status — up to date (${journal.entries.length} migrations applied)`);
