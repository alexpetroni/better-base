import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import nodeAdapter from '@sveltejs/adapter-node';
import vercelAdapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadRootEnv } from './scripts/env.ts';

// The .env lives at the repo root, shared with docker compose and drizzle-kit.
// Load it into process.env for dev/preview/test; existing env vars win. It also
// rewrites the compose-service URLs to the hostname reachable from this process
// (localhost on the host, host.docker.internal from a sibling container), so
// vitest/dev work from either without anyone editing .env.
loadRootEnv();

/**
 * Deployment target. `adapter-node` (a long-lived server next to docker
 * compose / on a VPS) stays the default; Vercel sets `VERCEL=1` in its build
 * container, and `DEPLOY_TARGET` forces either one so both outputs can be
 * produced locally. See DEPLOYMENT.md.
 *
 * The Vercel functions run on Node 22 — required by the Neon driver
 * (`DB_DRIVER=neon`), which needs a global `WebSocket`. Everything server-side
 * here is Node-only anyway (node:crypto, pg), so the edge runtime is never an
 * option.
 */
const target = process.env.DEPLOY_TARGET ?? (process.env.VERCEL ? 'vercel' : 'node');
const adapter = target === 'vercel' ? vercelAdapter({ runtime: 'nodejs22.x' }) : nodeAdapter();

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
			adapter
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
