import { defineConfig } from '@playwright/test';
import { E2E_STRIPE_WEBHOOK_SECRET, siteDatabaseUrl } from './e2e/env.ts';

// One build serves both sites: SITE_ID is read at runtime, so we start two
// preview servers from the same output. `pnpm test:e2e` builds first.
// Each server gets its own site database (auth sessions live in the DB).
// EMAIL_DRYRUN and an EMPTY STRIPE_SECRET_KEY are forced: an e2e run must
// never deliver real email nor call Stripe (empty key selects the mock).
function siteEnv(siteId: 'sleep' | 'life') {
	return {
		SITE_ID: siteId,
		DATABASE_URL: siteDatabaseUrl(siteId),
		EMAIL_DRYRUN: 'true',
		STRIPE_SECRET_KEY: '',
		STRIPE_WEBHOOK_SECRET: E2E_STRIPE_WEBHOOK_SECRET
	};
}

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
			env: siteEnv('sleep'),
			reuseExistingServer: false
		},
		{
			command: 'npm run preview -- --port 4174 --strictPort',
			port: 4174,
			env: siteEnv('life'),
			reuseExistingServer: false
		}
	]
});
