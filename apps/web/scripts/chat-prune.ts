// Retention job: delete chat sessions older than 30 days (messages cascade).
// Runs with plain node against DATABASE_URL — wire it into cron at deploy time
// (e.g. daily). Keep imports relative with explicit .ts extensions.
import path from 'node:path';
import { config } from 'dotenv';
import { createDb } from '../src/lib/db/client.ts';
import { CHAT_RETENTION_DAYS, pruneChatSessions } from '../src/lib/modules/chat/service.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set — configure the root .env');
	process.exit(1);
}

const db = createDb(url);
try {
	const deleted = await pruneChatSessions(db);
	console.log(`chat:prune — deleted ${deleted} session(s) older than ${CHAT_RETENTION_DAYS} days`);
} finally {
	await db.$client.end();
}
