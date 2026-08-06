import { defineConfig } from 'drizzle-kit';
import { loadRootEnv } from './scripts/env.ts';

// Env lives at the repo root; drizzle-kit runs with cwd = apps/web.
// loadRootEnv also points DATABASE_URL at the hostname that works from here
// (localhost on the host, host.docker.internal from a sibling container).
loadRootEnv();

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/db/schema/index.ts',
	out: './drizzle',
	dbCredentials: { url: process.env.DATABASE_URL }
});
