// Launch preflight — `pnpm launch:check [--dev] [--no-probe] [--allow-mock-providers] [--target=node|vercel]`.
//
// Run it with the TARGET environment's variables exported (exported vars win
// over the root .env, which is loaded for the local-dev case). It prints a
// numbered report of everything that would embarrass production — missing
// variables, committed dev defaults, http origin, target/secret mismatches —
// probes the selected image provider end-to-end, and reads the target
// database's site_settings to enforce that every launch-required setting is
// saved and no longer a seeded placeholder. Exit codes: 0 clean, 1 problems
// found, 2 usage error.
//
// Flags:
//   --dev       local-dev acknowledgement: dev defaults / http origin /
//               placeholder site settings are fine
//   --no-probe  skip the network checks (image probe AND the site-settings
//               database read) for an env-only check, e.g. from CI
//   --target=…  override the deploy target (default: vercel when VERCEL or
//               DEPLOY_TARGET=vercel is set, node otherwise)
//   --allow-mock-providers
//               acknowledge launching a live env (EMAIL_DRYRUN=false) on the
//               mock chat and/or courier provider (FIX-14), or rehearsing a
//               production env on dry-run email (EMAIL_DRYRUN=true — refused
//               otherwise outside --dev, FIX-18)
//
// Warnings (`warning: …` lines) are advisory: driver/target mismatches, an
// oversized pool on the neon driver, no error sink. They never fail the run.
//
// The env rules live in src/lib/server/launch-check.ts (variable list from the
// same env-matrix.ts declaration the boot validator uses); the site-settings
// rule lives in src/lib/modules/settings (settingsLaunchProblems).
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import { settingsLaunchProblems } from '../src/lib/modules/settings/server.ts';
import {
	imageProbeBlocker,
	fiscalProbeBlocker,
	launchCheckProblems,
	launchCheckWarnings,
	probeFiscalPrivacy,
	probeImages
} from '../src/lib/server/launch-check.ts';
import type { DeployTarget } from '../src/lib/server/env-matrix.ts';

const USAGE =
	'Usage: pnpm launch:check [--dev] [--no-probe] [--allow-mock-providers] [--target=node|vercel]';

const args = new Set(process.argv.slice(2));
const dev = args.delete('--dev');
const noProbe = args.delete('--no-probe');
// A live env on the mock chat/courier provider, or a production env still on
// dry-run email, is refused unless acknowledged.
const allowMockProviders = args.delete('--allow-mock-providers');
let target: DeployTarget | undefined;
for (const arg of [...args]) {
	if (!arg.startsWith('--target=')) continue;
	const value = arg.slice('--target='.length);
	if (value !== 'node' && value !== 'vercel') {
		console.error(`launch:check — unknown target "${value}"\n${USAGE}`);
		process.exit(2);
	}
	target = value;
	args.delete(arg);
}
if (args.size) {
	console.error(`launch:check — unknown argument(s): ${[...args].join(' ')}\n${USAGE}`);
	process.exit(2);
}

loadRootEnv();
const env = process.env;
const resolvedTarget: DeployTarget =
	target ?? (env.VERCEL || env.DEPLOY_TARGET === 'vercel' ? 'vercel' : 'node');

const problems = launchCheckProblems(env, { target: resolvedTarget, dev, allowMockProviders });
// Advisory only (FIX-16): printed, never fatal.
const warnings = launchCheckWarnings(env, { target: resolvedTarget, dev });

const notes: string[] = [];
const probeBlocker = noProbe ? '--no-probe' : imageProbeBlocker(env);
if (probeBlocker) {
	// Whatever blocks the probe (missing vars, an unbuildable provider) is
	// already reported by the env rules above — this is a note, not a problem.
	notes.push(`image probe skipped: ${probeBlocker}`);
} else {
	problems.push(...(await probeImages(env)));
}

// FIX-12: the public media origin must not serve invoices/. Skipped under
// --dev on purpose — the local MinIO media bucket is public by design and
// documents go to the fiscal bucket anyway.
const fiscalBlocker = noProbe ? '--no-probe' : dev ? '--dev' : fiscalProbeBlocker(env);
if (fiscalBlocker) {
	notes.push(`fiscal privacy probe skipped: ${fiscalBlocker}`);
} else {
	problems.push(...(await probeFiscalPrivacy(env)));
}

// Site-settings preflight: launch-required settings must be explicitly saved
// and no longer the seeded placeholders. --dev acknowledges placeholders the
// same way it acknowledges dev-default env values; --no-probe keeps the run
// env-only (CI has no database to dial).
if (dev) {
	notes.push('site-settings check skipped: --dev');
} else if (noProbe) {
	notes.push('site-settings check skipped: --no-probe');
} else if (!env.DATABASE_URL) {
	// Reported as a missing variable above.
	notes.push('site-settings check skipped: DATABASE_URL not set');
} else {
	const db = createDb(env.DATABASE_URL);
	try {
		problems.push(...(await settingsLaunchProblems({ db })));
	} catch (err) {
		problems.push(
			`site settings could not be read (${err instanceof Error ? err.message : err}) — is DATABASE_URL reachable and migrated?`
		);
	} finally {
		await db.$client.end();
	}
}
const probeNote = notes.length ? ` (${notes.join('; ')})` : '';

const label = `launch:check — target ${resolvedTarget}, SITE_ID ${env.SITE_ID ?? '(unset)'}${dev ? ', --dev' : ''}`;
warnings.forEach((warning) => console.warn(`  warning: ${warning}`));
if (problems.length) {
	console.error(`${label}: FAIL${probeNote}`);
	problems.forEach((problem, i) => console.error(`  ${i + 1}. ${problem}`));
	console.error(
		`${problems.length} problem(s). Fix every line above — DEPLOYMENT.md §2/§12 document each variable.`
	);
	process.exit(1);
}
console.log(`${label}: OK${probeNote}`);
