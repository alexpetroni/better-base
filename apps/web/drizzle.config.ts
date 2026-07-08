import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

// Env lives at the repo root; drizzle-kit runs with cwd = apps/web.
config({ path: '../../.env' });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/db/schema/index.ts',
	out: './drizzle',
	dbCredentials: { url: process.env.DATABASE_URL }
});
