import { defineConfig } from '@playwright/test';
import { siteDatabaseUrl } from './e2e/env.ts';

// One build serves both sites: SITE_ID is read at runtime, so we start two
// preview servers from the same output. `pnpm test:e2e` builds first.
// Each server gets its own site database (auth sessions live in the DB).
export default defineConfig({
	testMatch: '**/*.e2e.{ts,js}',
	globalSetup: './e2e/global-setup.ts',
	projects: [
		{ name: 'sleep', use: { baseURL: 'http://localhost:4173' } },
		{ name: 'life', use: { baseURL: 'http://localhost:4174' } }
	],
	webServer: [
		{
			command: 'npm run preview -- --port 4173 --strictPort',
			port: 4173,
			env: { SITE_ID: 'sleep', DATABASE_URL: siteDatabaseUrl('sleep') },
			reuseExistingServer: false
		},
		{
			command: 'npm run preview -- --port 4174 --strictPort',
			port: 4174,
			env: { SITE_ID: 'life', DATABASE_URL: siteDatabaseUrl('life') },
			reuseExistingServer: false
		}
	]
});
