// Launch preflight — `pnpm launch:check [--dev] [--no-probe] [--target=node|vercel]`.
//
// Run it with the TARGET environment's variables exported (exported vars win
// over the root .env, which is loaded for the local-dev case). It prints a
// numbered report of everything that would embarrass production — missing
// variables, committed dev defaults, http origin, target/secret mismatches —
// and probes the live imgproxy for signature agreement. Exit codes: 0 clean,
// 1 problems found, 2 usage error.
//
// Flags:
//   --dev       local-dev acknowledgement: dev defaults / http origin are fine
//   --no-probe  skip the network probe (env-only check, e.g. from CI)
//   --target=…  override the deploy target (default: vercel when VERCEL or
//               DEPLOY_TARGET=vercel is set, node otherwise)
//
// The rules live in src/lib/server/launch-check.ts; the variable list is the
// same env-matrix.ts declaration the boot validator uses.
import { loadRootEnv } from './env.ts';
import {
	canProbeImgproxy,
	launchCheckProblems,
	probeImgproxy
} from '../src/lib/server/launch-check.ts';
import type { DeployTarget } from '../src/lib/server/env-matrix.ts';

const USAGE = 'Usage: pnpm launch:check [--dev] [--no-probe] [--target=node|vercel]';

const args = new Set(process.argv.slice(2));
const dev = args.delete('--dev');
const noProbe = args.delete('--no-probe');
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

const problems = launchCheckProblems(env, { target: resolvedTarget, dev });

let probeNote = '';
if (noProbe) {
	probeNote = ' (imgproxy probe skipped: --no-probe)';
} else if (!canProbeImgproxy(env)) {
	// The vars the probe needs are missing — already reported above.
	probeNote = ' (imgproxy probe skipped: IMGPROXY_*/S3_* incomplete)';
} else {
	problems.push(...(await probeImgproxy(env)));
}

const label = `launch:check — target ${resolvedTarget}, SITE_ID ${env.SITE_ID ?? '(unset)'}${dev ? ', --dev' : ''}`;
if (problems.length) {
	console.error(`${label}: FAIL${probeNote}`);
	problems.forEach((problem, i) => console.error(`  ${i + 1}. ${problem}`));
	console.error(
		`${problems.length} problem(s). Fix every line above — DEPLOYMENT.md §2/§12 document each variable.`
	);
	process.exit(1);
}
console.log(`${label}: OK${probeNote}`);
