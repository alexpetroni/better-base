/**
 * Launch preflight rules for `pnpm launch:check` (scripts/launch-check.ts):
 * run against a TARGET environment's variables before a deploy, it reports
 * every way that env would embarrass production — missing variables, committed
 * dev defaults, an http origin, target/secret mismatches — plus a live probe
 * that proves the app's imgproxy key/salt agree with the imgproxy instance.
 *
 * Framework-free like boot.ts (the env record is passed in) so the rules are
 * unit-testable offline; the variable list comes from `env-matrix.ts`, the
 * SAME declaration the boot validator uses. Kept separate from boot.ts because
 * these checks are deploy-time-only: an app boots fine on dev defaults — it
 * just must never LAUNCH on them.
 */
import { resolveSiteConfig } from '../config/index.ts';
import { imgproxyConfigFromEnv, storageConfigFromEnv } from '../modules/media/env.ts';
import { buildImgUrl, imgproxyPath } from '../modules/media/imgproxy.ts';
import { createStorage } from '../modules/media/storage.ts';
import { bootEnvProblems, REQUIRED_BOOT_ENV } from './boot.ts';
import { devDefaultProblem, ENV_MATRIX, requiredEnvFor, type DeployTarget } from './env-matrix.ts';

type Env = Record<string, string | undefined>;

export interface LaunchCheckOptions {
	target: DeployTarget;
	/**
	 * `--dev` acknowledgement: this is a local dev env, so dev defaults, an
	 * http origin and a localhost domain are fine. Missing variables and
	 * conditional requirements are still enforced.
	 */
	dev?: boolean;
}

/** Every problem found in `env` for the given target; empty means launch-worthy. */
export function launchCheckProblems(env: Env, opts: LaunchCheckOptions): string[] {
	// Boot problems first: missing boot vars + the conditional requirements
	// (RESEND_API_KEY, STRIPE_WEBHOOK_SECRET, TOKEN_SECRET≠BETTER_AUTH_SECRET).
	const problems = [...bootEnvProblems(env)];

	if (opts.target === 'vercel') {
		problems.push(
			...requiredEnvFor('vercel')
				.filter((name) => !env[name] && !REQUIRED_BOOT_ENV.includes(name))
				.map((name) => `${name} is not set (required on the vercel target — DEPLOYMENT.md §12)`)
		);
	}

	// The app-side equivalent lives in the chat provider's own boot check
	// (modules/chat/server.ts); the preflight runs outside the app, so it
	// re-derives the same rule from the same env.
	if (env.CHAT_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
		problems.push('ANTHROPIC_API_KEY is required when CHAT_PROVIDER=anthropic');
	}

	if (opts.dev) return problems;

	// --- production-only rules below ---------------------------------------

	for (const spec of ENV_MATRIX) {
		const problem = devDefaultProblem(spec.name, env[spec.name]);
		if (problem) problems.push(problem);
	}

	if (env.PUBLIC_SITE_URL) {
		let parsed: URL | null = null;
		try {
			parsed = new URL(env.PUBLIC_SITE_URL);
		} catch {
			problems.push(`PUBLIC_SITE_URL is not a valid URL: "${env.PUBLIC_SITE_URL}"`);
		}
		if (parsed && parsed.protocol !== 'https:') {
			problems.push(
				`PUBLIC_SITE_URL must be https in production (got ${env.PUBLIC_SITE_URL}) — session cookies derive Secure from it`
			);
		}
		if (parsed && env.SITE_ID) {
			try {
				const site = resolveSiteConfig(env.SITE_ID);
				if (parsed.hostname !== site.domain) {
					problems.push(
						`PUBLIC_SITE_URL host "${parsed.hostname}" does not match the ${site.id} site domain "${site.domain}" — wrong SITE_ID or wrong URL`
					);
				}
			} catch (err) {
				problems.push(err instanceof Error ? err.message : String(err));
			}
		}
	}

	// The imgproxy pair has no committed default to grep for — a dev-shaped
	// value is one that openssl rand -hex 32 could not have produced.
	for (const name of ['IMGPROXY_KEY', 'IMGPROXY_SALT'] as const) {
		const value = env[name];
		if (value && !/^[0-9a-f]{32,}$/i.test(value)) {
			problems.push(
				`${name} does not look like a generated secret (hex, 32+ chars — openssl rand -hex 32)`
			);
		}
	}
	if (env.IMGPROXY_KEY && env.IMGPROXY_KEY === env.IMGPROXY_SALT) {
		problems.push('IMGPROXY_SALT must differ from IMGPROXY_KEY — generate a separate value');
	}

	// EMAIL_DRYRUN=false is the "this env is live" signal: real emails go out,
	// so a test-mode Stripe key is a mistake, not a stage.
	if (env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && env.EMAIL_DRYRUN === 'false') {
		problems.push(
			'STRIPE_SECRET_KEY is a TEST key (sk_test_…) in a live env (EMAIL_DRYRUN=false) — set the live key, or keep EMAIL_DRYRUN=true until launch'
		);
	}

	return problems;
}

/** Can the probe run at all with this env? (Missing vars are reported elsewhere.) */
export function canProbeImgproxy(env: Env): boolean {
	const imgproxy = imgproxyConfigFromEnv(env);
	const storage = storageConfigFromEnv(env);
	return Boolean(
		imgproxy.baseUrl &&
		imgproxy.key &&
		imgproxy.salt &&
		storage.endpoint &&
		storage.accessKey &&
		storage.secretKey &&
		storage.bucket
	);
}

/** Where the probe object lives while the probe runs; deleted afterwards. */
export const IMGPROXY_PROBE_KEY = 'launch-check/probe.png';

/** A 1×1 transparent PNG — the smallest source imgproxy will happily transform. */
const PROBE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/**
 * Live imgproxy probe: upload a tiny object with the app's S3 credentials,
 * then require the SIGNED imgproxy URL for it to answer 200 and an UNSIGNED
 * one to answer 403. That single round trip proves `IMGPROXY_URL` is
 * reachable, imgproxy can read the bucket with its own credentials, the
 * key/salt pair matches between app and imgproxy (the most likely silent prod
 * breakage — every image 403s), and signature enforcement is actually on.
 * The probe object is deleted afterwards; a failed cleanup is reported, not
 * fatal.
 */
export async function probeImgproxy(env: Env): Promise<string[]> {
	const imgproxy = imgproxyConfigFromEnv(env);
	const storage = createStorage(storageConfigFromEnv(env));
	const problems: string[] = [];

	try {
		await storage.putObject(IMGPROXY_PROBE_KEY, PROBE_PNG, 'image/png');
	} catch (err) {
		return [
			`imgproxy probe: could not upload s3://${storage.bucket}/${IMGPROXY_PROBE_KEY} — S3 endpoint/credentials/bucket broken? (${err instanceof Error ? err.message : err})`
		];
	}

	try {
		const signed = buildImgUrl(imgproxy, IMGPROXY_PROBE_KEY, { w: 16, format: 'png' });
		const unsigned = `${imgproxy.baseUrl.replace(/\/$/, '')}/unsigned${imgproxyPath(imgproxy, IMGPROXY_PROBE_KEY, { w: 16, format: 'png' })}`;

		const ok = await fetch(signed);
		if (ok.status !== 200) {
			problems.push(
				`imgproxy probe: signed URL answered ${ok.status}, expected 200 — ` +
					(ok.status === 403
						? 'IMGPROXY_KEY/IMGPROXY_SALT do not match the imgproxy instance'
						: 'is imgproxy pointed at this bucket with working read credentials?')
			);
		}
		const denied = await fetch(unsigned);
		if (denied.status !== 403) {
			problems.push(
				`imgproxy probe: UNSIGNED URL answered ${denied.status}, expected 403 — signature enforcement is off (imgproxy is missing its key/salt)`
			);
		}
	} catch (err) {
		problems.push(
			`imgproxy probe: ${imgproxy.baseUrl} is not reachable from here (${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err})`
		);
	} finally {
		try {
			await storage.deleteObject(IMGPROXY_PROBE_KEY);
		} catch {
			problems.push(
				`imgproxy probe: cleanup failed — delete s3://${storage.bucket}/${IMGPROXY_PROBE_KEY} by hand`
			);
		}
	}

	return problems;
}
