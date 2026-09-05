/**
 * Launch preflight rules for `pnpm launch:check` (scripts/launch-check.ts):
 * run against a TARGET environment's variables before a deploy, it reports
 * every way that env would embarrass production — missing variables, committed
 * dev defaults, an http origin, target/secret mismatches — plus a live probe
 * of the selected image provider (DEPLOYMENT.md §6), which proves that real
 * visitors will actually see images.
 *
 * Framework-free like boot.ts (the env record is passed in) so the rules are
 * unit-testable offline; the variable list comes from `env-matrix.ts`, the
 * SAME declaration the boot validator uses. Kept separate from boot.ts because
 * these checks are deploy-time-only: an app boots fine on dev defaults — it
 * just must never LAUNCH on them.
 */
import { resolveSiteConfig } from '../config/index.ts';
import { selectAnalyticsProvider } from '../modules/analytics/server.ts';
import { buildCloudflareImageUrl, cloudflareOriginUrl } from '../modules/media/cloudflare.ts';
import {
	cloudflareConfigFromEnv,
	imageProviderFromEnv,
	imageProviderNameFromEnv,
	imgproxyConfigFromEnv,
	storageConfigFromEnv
} from '../modules/media/env.ts';
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

	// A half-configured analytics provider would 500 every public page load —
	// surface it here with the seam's own error message.
	try {
		selectAnalyticsProvider(env);
	} catch (cause) {
		problems.push(cause instanceof Error ? cause.message : String(cause));
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

	problems.push(...imageProviderProblems(env));
	problems.push(...fiscalStorageProblems(env));

	// EMAIL_DRYRUN=false is the "this env is live" signal: real emails go out,
	// so a test-mode Stripe key is a mistake, not a stage.
	if (env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && env.EMAIL_DRYRUN === 'false') {
		problems.push(
			'STRIPE_SECRET_KEY is a TEST key (sk_test_…) in a live env (EMAIL_DRYRUN=false) — set the live key, or keep EMAIL_DRYRUN=true until launch'
		);
	}

	return problems;
}

/**
 * Production-only image-delivery rules. Which ones apply depends on
 * IMAGE_PROVIDER, so they live together here rather than as unconditional
 * lines in `launchCheckProblems`.
 */
export function imageProviderProblems(env: Env): string[] {
	const problems: string[] = [];
	let provider: ReturnType<typeof imageProviderNameFromEnv>;
	try {
		provider = imageProviderNameFromEnv(env);
	} catch {
		// An unknown IMAGE_PROVIDER is already reported by the boot check.
		return problems;
	}

	// `direct` hands visitors the untouched original — a 4 MB phone photo on a
	// 3G connection. It exists for local dev, and shipping it is always a
	// misconfiguration, never a choice.
	if (provider === 'direct') {
		problems.push(
			'IMAGE_PROVIDER=direct serves unresized originals — set cloudflare (Vercel) or imgproxy (VPS); see DEPLOYMENT.md §6'
		);
	}

	// Both public image origins are rendered into every page: on http they
	// would be mixed content and the browser would block them outright.
	for (const name of ['MEDIA_PUBLIC_BASE_URL', 'CF_IMAGE_BASE_URL'] as const) {
		const value = env[name];
		if (!value) continue;
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			problems.push(`${name} is not a valid URL: "${value}"`);
			continue;
		}
		if (parsed.protocol !== 'https:') {
			problems.push(
				`${name} must be https in production (got ${value}) — images would be mixed content`
			);
		}
	}

	if (provider !== 'imgproxy') return problems;

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
	return problems;
}

/**
 * Production-only fiscal-storage rules (FIX-12, audit P0 #4). Under the
 * cloudflare provider the media bucket is bound to a public domain and R2
 * public access is not prefix-scoped, so fiscal documents need their OWN
 * bucket, named explicitly — a derived default would silently be a bucket
 * nobody created or bound correctly. On every target the two must differ.
 */
export function fiscalStorageProblems(env: Env): string[] {
	const problems: string[] = [];
	const fiscal = env.S3_INVOICE_BUCKET;
	if (!fiscal && imageProviderNameFromEnv(env) === 'cloudflare') {
		problems.push(
			'S3_INVOICE_BUCKET is required when IMAGE_PROVIDER=cloudflare — the media bucket is publicly bound, fiscal documents need a private one (DEPLOYMENT.md §5)'
		);
	}
	if (fiscal && fiscal === env.S3_BUCKET) {
		problems.push(
			`S3_INVOICE_BUCKET must not be the media bucket ("${fiscal}") — invoice PDFs/XML would sit behind the public media domain`
		);
	}
	return problems;
}

/**
 * Why the fiscal privacy probe cannot run with this env, or null when it
 * can: it needs storage credentials and a public media origin to test.
 */
export function fiscalProbeBlocker(env: Env): string | null {
	const storage = storageConfigFromEnv(env);
	if (!storage.endpoint || !storage.accessKey || !storage.secretKey || !storage.bucket) {
		return 'S3_* incomplete';
	}
	if (!env.MEDIA_PUBLIC_BASE_URL)
		return 'MEDIA_PUBLIC_BASE_URL is not set (no public media origin)';
	return null;
}

/** Where the privacy probe object lives while the probe runs; deleted afterwards. */
export const FISCAL_PROBE_KEY = 'invoices/launch-check-probe.txt';

/**
 * Live fiscal privacy probe (FIX-12, audit P0 #4): upload a tiny object under
 * `invoices/` in the MEDIA bucket and prove the public media origin does NOT
 * serve it. Whatever the bucket layout, a 200 here means a leftover or
 * misrouted fiscal document would be world-readable. A failed cleanup is
 * reported, not fatal.
 */
export async function probeFiscalPrivacy(env: Env): Promise<string[]> {
	const storage = createStorage(storageConfigFromEnv(env));
	const problems: string[] = [];
	try {
		await storage.putObject(FISCAL_PROBE_KEY, 'launch-check fiscal privacy probe', 'text/plain');
	} catch (err) {
		return [
			`fiscal privacy probe: could not upload s3://${storage.bucket}/${FISCAL_PROBE_KEY} — S3 endpoint/credentials/bucket broken? (${err instanceof Error ? err.message : err})`
		];
	}
	const url = `${env.MEDIA_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${FISCAL_PROBE_KEY}`;
	try {
		const res = await fetch(url);
		if (res.status === 200) {
			problems.push(
				`fiscal privacy probe: ${url} is PUBLICLY readable (200) — the media origin serves invoices/; move documents to S3_INVOICE_BUCKET (pnpm storage:fiscal-migrate) and block /invoices/* on the media host (DEPLOYMENT.md §5)`
			);
		}
	} catch (err) {
		problems.push(
			`fiscal privacy probe: ${env.MEDIA_PUBLIC_BASE_URL} is not reachable from here (${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err})`
		);
	} finally {
		try {
			await storage.deleteObject(FISCAL_PROBE_KEY);
		} catch {
			problems.push(
				`fiscal privacy probe: cleanup failed — delete s3://${storage.bucket}/${FISCAL_PROBE_KEY} by hand`
			);
		}
	}
	return problems;
}

/**
 * Why the image probe cannot run with this env, or null when it can. Missing
 * variables are reported by the env rules, so this only decides whether the
 * network round trip is worth attempting.
 */
export function imageProbeBlocker(env: Env): string | null {
	const storage = storageConfigFromEnv(env);
	if (!storage.endpoint || !storage.accessKey || !storage.secretKey || !storage.bucket) {
		return 'S3_* incomplete';
	}
	try {
		const provider = imageProviderFromEnv(env);
		// `direct` has nothing to prove: it hands back the stored original, and
		// the env rules already refuse it on a production target.
		if (!provider.transforms) return `IMAGE_PROVIDER=${provider.name} has no transforms to probe`;
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
	return null;
}

/** Where the probe object lives while the probe runs; deleted afterwards. */
export const IMAGE_PROBE_KEY = 'launch-check/probe.png';

/** A 1×1 transparent PNG — the smallest source a transformer will happily accept. */
const PROBE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/**
 * Live image-delivery probe: upload a tiny object with the app's S3
 * credentials, ask the selected provider for a derivative of it, then delete
 * it. Dispatches on IMAGE_PROVIDER — the two providers can break in completely
 * different ways, so they get completely different assertions. A failed
 * cleanup is reported, not fatal.
 */
export async function probeImages(env: Env): Promise<string[]> {
	const storage = createStorage(storageConfigFromEnv(env));
	const problems: string[] = [];

	try {
		await storage.putObject(IMAGE_PROBE_KEY, PROBE_PNG, 'image/png');
	} catch (err) {
		return [
			`image probe: could not upload s3://${storage.bucket}/${IMAGE_PROBE_KEY} — S3 endpoint/credentials/bucket broken? (${err instanceof Error ? err.message : err})`
		];
	}

	try {
		const provider = imageProviderNameFromEnv(env);
		problems.push(
			...(provider === 'imgproxy' ? await probeImgproxyUrls(env) : await probeCloudflareUrls(env))
		);
	} catch (err) {
		problems.push(`image probe: ${err instanceof Error ? err.message : err}`);
	} finally {
		try {
			await storage.deleteObject(IMAGE_PROBE_KEY);
		} catch {
			problems.push(
				`image probe: cleanup failed — delete s3://${storage.bucket}/${IMAGE_PROBE_KEY} by hand`
			);
		}
	}

	return problems;
}

/**
 * imgproxy: the SIGNED URL must answer 200 and an UNSIGNED one 403. That
 * single round trip proves `IMGPROXY_URL` is reachable, imgproxy can read the
 * bucket with its own credentials, the key/salt pair matches between app and
 * imgproxy (the most likely silent prod breakage — every image 403s), and
 * signature enforcement is actually on.
 */
async function probeImgproxyUrls(env: Env): Promise<string[]> {
	const imgproxy = imgproxyConfigFromEnv(env);
	const problems: string[] = [];
	try {
		const signed = buildImgUrl(imgproxy, IMAGE_PROBE_KEY, { w: 16, format: 'png' });
		const unsigned = `${imgproxy.baseUrl.replace(/\/$/, '')}/unsigned${imgproxyPath(imgproxy, IMAGE_PROBE_KEY, { w: 16, format: 'png' })}`;

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
	}
	return problems;
}

/**
 * Cloudflare: two round trips, because there are two independent ways this
 * breaks and one message must not hide the other.
 *
 *   1. the ORIGIN URL — proves the R2 bucket really is published at
 *      MEDIA_PUBLIC_BASE_URL (a missing custom-domain binding 404s here);
 *   2. the /cdn-cgi/image URL — proves transformations are enabled on the
 *      zone. When they are NOT, Cloudflare quietly passes the source through
 *      untouched, so a 200 alone proves nothing: we ask for `format=webp` and
 *      require the response to actually BE webp. A PNG coming back means the
 *      site would serve full-size originals to every visitor while looking
 *      perfectly healthy.
 */
async function probeCloudflareUrls(env: Env): Promise<string[]> {
	const cfg = cloudflareConfigFromEnv(env);
	const problems: string[] = [];

	const origin = cloudflareOriginUrl(cfg, IMAGE_PROBE_KEY);
	try {
		const res = await fetch(origin);
		if (res.status !== 200) {
			problems.push(
				`cloudflare probe: origin ${origin} answered ${res.status}, expected 200 — is the R2 bucket bound to MEDIA_PUBLIC_BASE_URL as a public custom domain? (DEPLOYMENT.md §6)`
			);
		}
	} catch (err) {
		problems.push(
			`cloudflare probe: origin ${cfg.originBaseUrl} is not reachable from here (${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err})`
		);
		return problems;
	}

	const transformed = buildCloudflareImageUrl(cfg, IMAGE_PROBE_KEY, { w: 16, format: 'webp' });
	try {
		const res = await fetch(transformed);
		if (res.status !== 200) {
			problems.push(
				`cloudflare probe: ${transformed} answered ${res.status}, expected 200 — is ${cfg.baseUrl} a Cloudflare-proxied zone?`
			);
			return problems;
		}
		const type = res.headers.get('content-type') ?? '(none)';
		if (!type.includes('image/webp')) {
			problems.push(
				`cloudflare probe: asked for format=webp and got "${type}" — Image Transformations are OFF for this zone, so /cdn-cgi/image passes originals through unresized (enable them: Cloudflare dashboard → Images → Transformations)`
			);
		}
	} catch (err) {
		problems.push(
			`cloudflare probe: ${cfg.baseUrl} is not reachable from here (${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err})`
		);
	}
	return problems;
}
