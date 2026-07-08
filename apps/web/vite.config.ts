import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { config } from 'dotenv';
import path from 'node:path';

// The .env lives at the repo root, shared with docker compose and drizzle-kit.
// Load it into process.env for dev/preview/test; existing env vars win.
config({ path: path.resolve(import.meta.dirname, '../../.env') });

export default defineConfig({
	envDir: '../../',
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		}),
		paraglideVitePlugin({ project: './project.inlang', outdir: './src/lib/paraglide' })
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					setupFiles: ['./tests/vitest-setup.ts'],
					// Integration specs reset and re-migrate the shared test database;
					// running spec files concurrently would have them race each other.
					fileParallelism: false
				}
			}
		]
	}
});
