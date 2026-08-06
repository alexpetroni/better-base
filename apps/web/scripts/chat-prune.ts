// Retention job: delete chat sessions older than 30 days (messages cascade)
// and sweep expired rate-limit counter rows. Runs with plain node against
// DATABASE_URL — wire it into cron at deploy time (e.g. daily).
//
// The work itself lives in `src/lib/server/retention.ts`, shared with the
// /api/cron/chat-prune route used on Vercel (no machine to run scripts on).
// Keep imports relative with explicit .ts extensions.
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import { formatRetentionSweep, runRetentionSweep } from '../src/lib/server/retention.ts';

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set — configure the root .env');
	process.exit(1);
}

const db = createDb(url);
try {
	console.log(`chat:prune — ${formatRetentionSweep(await runRetentionSweep(db))}`);
} finally {
	await db.$client.end();
}
