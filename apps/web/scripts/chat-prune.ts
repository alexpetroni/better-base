// Retention job: delete chat sessions older than 30 days (messages cascade)
// and sweep expired rate-limit counter rows — the limiter upserts one row per
// key (`ip:`, `session:`, `newsletter:ip:`, …) and never deletes, so the
// counter tables grow unbounded without this (audit resilience #6).
// Runs with plain node against DATABASE_URL — wire it into cron at deploy time
// (e.g. daily). Keep imports relative with explicit .ts extensions.
import path from 'node:path';
import { config } from 'dotenv';
import { createDb } from '../src/lib/db/client.ts';
import { loginAttempts } from '../src/lib/modules/auth/schema.ts';
import { CHAT_RETENTION_DAYS, pruneChatSessions } from '../src/lib/modules/chat/service.ts';
import { pruneStaleRateLimits } from '../src/lib/server/rate-limit/core.ts';
import { rateLimits } from '../src/lib/server/rate-limit/schema.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set — configure the root .env');
	process.exit(1);
}

const db = createDb(url);
try {
	const cutoff = new Date(Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const chat = await pruneChatSessions(db);
	// Same counter shape, same growth pattern: the public-email and login
	// limiters. Their windows are minutes-to-an-hour, so the 30-day cutoff is
	// far past any row that still influences a decision.
	const publicEmail = await pruneStaleRateLimits(db, rateLimits, cutoff);
	const login = await pruneStaleRateLimits(db, loginAttempts, cutoff);
	console.log(
		`chat:prune — deleted ${chat.sessions} session(s) older than ${CHAT_RETENTION_DAYS} days, ` +
			`${chat.rateLimitRows} chat / ${publicEmail} public-email / ${login} login rate-limit row(s)`
	);
} finally {
	await db.$client.end();
}
