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
			adapter,
			// The origin check lives in hooks.server.ts (handleCsrf) with the same
			// rule plus one exemption — the RFC 8058 one-click unsubscribe POST
			// mail clients send without an Origin header. See $lib/server/csrf.
			csrf: { checkOrigin: false },
			// The STATIC half of the CSP — kit nonces its inline bootstrap under
			// 'strict-dynamic' (script tags the nonced bootstrap creates are
			// trusted transitively, which is how the consent-gated analytics
			// loader injects its script). The env-derived half (img-src,
			// connect-src, frame-src, form-action, frame-ancestors) is appended
			// per-response by handleSecurityHeaders in hooks.server.ts.
			// NOTE: SvelteKit strips 'strict-dynamic' in dev — validate CSP
			// behavior on `pnpm build && pnpm preview`, never on the dev server.
			csp: {
				mode: 'auto',
				directives: {
					'script-src': ['self', 'strict-dynamic'],
					// Inline styles are load-bearing: the theme token style
					// attribute, blurhash placeholders and the quiz score bar.
					'style-src': ['self', 'unsafe-inline'],
					'object-src': ['none'],
					'base-uri': ['self']
				}
			}
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
