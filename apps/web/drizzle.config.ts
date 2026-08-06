import { defineConfig } from 'drizzle-kit';
import { loadRootEnv } from './scripts/env.ts';

// Env lives at the repo root; drizzle-kit runs with cwd = apps/web.
// loadRootEnv also points DATABASE_URL at the hostname that works from here
// (localhost on the host, host.docker.internal from a sibling container).
loadRootEnv();

// DDL prefers a DIRECT (unpooled) connection: Neon's pooled endpoint runs
// PgBouncer in transaction mode, where migrations that need session state or
// advisory locks can misbehave. Set DIRECT_DATABASE_URL to Neon's non-pooler
// host; everywhere else it is unset and DATABASE_URL is already direct.
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/db/schema/index.ts',
	out: './drizzle',
	dbCredentials: { url }
});
