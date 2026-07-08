import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts', // unit tests (*.test.ts) run under Vitest
	fullyParallel: true,
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:4322'
	},
	webServer: {
		command: 'npm run build && npm run preview -- --port 4322',
		url: 'http://localhost:4322',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
