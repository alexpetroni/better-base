// Shared env loading for every tooling entry point (CLI scripts, vite/vitest
// config, drizzle config): read the root `.env`, then point the compose-service
// URLs at whichever hostname works from HERE — `localhost` on the host,
// `host.docker.internal` from a sibling container. See
// `src/lib/config/hosts.ts` for the rule and why only those vars move.
//
// This is tooling-only (node:fs), never imported by app code.
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeServiceHosts } from '../src/lib/config/hosts.ts';

/**
 * The repo-root `.env`, shared with docker compose and drizzle-kit.
 * drizzle-kit bundles its config file, and `import.meta.dirname` is undefined
 * in that bundle — fall back to the path relative to cwd, which drizzle-kit
 * (and every `pnpm --filter web` script) sets to `apps/web`.
 */
export const ROOT_ENV = path.resolve(import.meta.dirname ?? 'scripts', '../../../.env');

/**
 * Are we inside a container? `/.dockerenv` covers Docker; the cgroup path
 * covers containerd/Kubernetes runtimes that omit it. Errors mean "no".
 *
 * Build machines (Vercel, CI) are containers too, but there is no docker host
 * with published ports next to them — their services are real remote hosts, so
 * they report `false` and no rewrite can fire. Today's rule only touches
 * localhost-ish hostnames, which makes this belt-and-braces.
 */
export function inContainer(): boolean {
	if (process.env.VERCEL || process.env.CI) return false;
	if (existsSync('/.dockerenv')) return true;
	try {
		return /\b(docker|containerd|kubepods|libpod)\b/.test(readFileSync('/proc/1/cgroup', 'utf8'));
	} catch {
		return false;
	}
}

/**
 * Load the root `.env` into `process.env` (existing vars win, as dotenv does)
 * and normalize the service hostnames. Returns the variables that were
 * rewritten so a caller can report it.
 */
export function loadRootEnv(envPath: string = ROOT_ENV): string[] {
	config({ path: envPath });
	return normalizeServiceHosts(process.env, inContainer());
}
