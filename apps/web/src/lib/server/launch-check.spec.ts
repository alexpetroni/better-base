import { describe, expect, it } from 'vitest';
import { bootEnvProblems, REQUIRED_BOOT_ENV } from './boot.ts';
import { devDefaultProblem, ENV_MATRIX, requiredEnvFor, type DeployTarget } from './env-matrix.ts';
import {
	fiscalProbeBlocker,
	imageProbeBlocker,
	launchCheckProblems,
	probeFiscalPrivacy,
	probeImages
} from './launch-check.ts';

/** A prod-shaped env every rule passes on; cases knock single values out. */
function prodEnv(): Record<string, string | undefined> {
	return {
		SITE_ID: 'sleep',
		DATABASE_URL: 'postgres://app:s3cr3t@db.prod.example.com/better_sleep',
		PUBLIC_SITE_URL: 'https://bettersleep.ro',
		BETTER_AUTH_SECRET: 'a-real-generated-auth-secret-value',
		TOKEN_SECRET: 'a-real-generated-token-secret-value',
		S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
		S3_ACCESS_KEY: 'r2-access-key-id',
		S3_SECRET_KEY: 'r2-secret-access-key',
		S3_BUCKET: 'bettersleep-media',
		// FIX-12: fiscal documents live in their own PRIVATE bucket; under the
		// cloudflare provider the media bucket is publicly bound, so this is
		// required there (DEPLOYMENT.md §5).
		S3_INVOICE_BUCKET: 'bettersleep-fiscal',
		// The Vercel-target default: Cloudflare transforms in front of the public
		// R2 origin, no transformer box of our own (DEPLOYMENT.md §6).
		IMAGE_PROVIDER: 'cloudflare',
		MEDIA_PUBLIC_BASE_URL: 'https://media.bettersleep.ro',
		CF_IMAGE_BASE_URL: 'https://bettersleep.ro',
		EMAIL_DRYRUN: 'true'
	};
}

/** The same env on the self-hosted target: imgproxy instead of Cloudflare. */
function imgproxyProdEnv(): Record<string, string | undefined> {
	const env = prodEnv();
	delete env.MEDIA_PUBLIC_BASE_URL;
	delete env.CF_IMAGE_BASE_URL;
	return {
		...env,
		IMAGE_PROVIDER: 'imgproxy',
		IMGPROXY_URL: 'https://img.bettersleep.ro',
		IMGPROXY_KEY: '0f'.repeat(32),
		IMGPROXY_SALT: 'a1'.repeat(32)
	};
}

function vercelEnv(): Record<string, string | undefined> {
	return {
		...prodEnv(),
		DIRECT_DATABASE_URL: 'postgres://app:s3cr3t@db.prod.example.com/better_sleep',
		CRON_SECRET: 'b2'.repeat(32)
	};
}

/** The dev env as .env.example ships it (dev defaults, http, localhost). */
function devEnv(): Record<string, string | undefined> {
	return {
		SITE_ID: 'sleep',
		DATABASE_URL: 'postgres://better:better@localhost:5433/better_sleep',
		PUBLIC_SITE_URL: 'http://localhost:5173',
		BETTER_AUTH_SECRET: 'dev-only-secret-change-me-0123456789',
		TOKEN_SECRET: 'dev-only-token-secret-change-me-9876543210',
		S3_ENDPOINT: 'http://localhost:9000',
		S3_ACCESS_KEY: 'better-media',
		S3_SECRET_KEY: 'better-media-secret',
		S3_BUCKET: 'better-base-media',
		// No IMAGE_PROVIDER: a stock checkout defaults to `direct`, and the
		// origin is derived from S3_ENDPOINT + S3_BUCKET.
		STRIPE_WEBHOOK_SECRET: 'whsec_dev_only_secret_change_me',
		EMAIL_DRYRUN: 'true',
		CHAT_PROVIDER: 'mock'
	};
}

// One case per rule — each defect must produce its own distinct failure.
const CASES: Array<{
	name: string;
	target?: DeployTarget;
	/** Starting env; defaults to the Cloudflare-shaped prod env. */
	base?: () => Record<string, string | undefined>;
	mutate: (env: Record<string, string | undefined>) => void;
	message: RegExp;
}> = [
	{
		name: 'a missing required var',
		mutate: (env) => delete env.S3_BUCKET,
		message: /^S3_BUCKET is not set$/m
	},
	{
		name: 'the dev-default auth secret',
		mutate: (env) => (env.BETTER_AUTH_SECRET = 'dev-only-secret-change-me-0123456789'),
		message: /BETTER_AUTH_SECRET is the committed dev default/
	},
	{
		name: 'the dev-default token secret',
		mutate: (env) => (env.TOKEN_SECRET = 'dev-only-token-secret-change-me-9876543210'),
		message: /TOKEN_SECRET is the committed dev default/
	},
	{
		name: 'compose database credentials',
		mutate: (env) => (env.DATABASE_URL = 'postgres://better:better@host:5433/better_sleep'),
		message: /DATABASE_URL carries the local compose credentials/
	},
	{
		name: 'the MinIO dev access key',
		mutate: (env) => (env.S3_ACCESS_KEY = 'better-media'),
		message: /S3_ACCESS_KEY is the committed dev default/
	},
	{
		name: 'the MinIO dev secret key',
		mutate: (env) => (env.S3_SECRET_KEY = 'better-media-secret'),
		message: /S3_SECRET_KEY is the committed dev default/
	},
	{
		name: 'the dev Stripe webhook secret',
		mutate: (env) => (env.STRIPE_WEBHOOK_SECRET = 'whsec_dev_only_secret_change_me'),
		message: /STRIPE_WEBHOOK_SECRET is the committed dev default/
	},
	{
		name: 'an http PUBLIC_SITE_URL',
		mutate: (env) => (env.PUBLIC_SITE_URL = 'http://bettersleep.ro'),
		message: /PUBLIC_SITE_URL must be https/
	},
	{
		name: 'a PUBLIC_SITE_URL not matching the SITE_ID domain',
		mutate: (env) => (env.PUBLIC_SITE_URL = 'https://betterlife.ro'),
		message: /does not match the sleep site domain "bettersleep\.ro"/
	},
	{
		name: 'an unparseable PUBLIC_SITE_URL',
		mutate: (env) => (env.PUBLIC_SITE_URL = 'bettersleep.ro'),
		message: /PUBLIC_SITE_URL is not a valid URL/
	},
	{
		name: 'a dev-shaped imgproxy key',
		base: imgproxyProdEnv,
		mutate: (env) => (env.IMGPROXY_KEY = 'aa'),
		message: /IMGPROXY_KEY does not look like a generated secret/
	},
	{
		name: 'an imgproxy salt equal to the key',
		base: imgproxyProdEnv,
		mutate: (env) => (env.IMGPROXY_SALT = env.IMGPROXY_KEY),
		message: /IMGPROXY_SALT must differ from IMGPROXY_KEY/
	},
	// Image delivery is provider-selected, so each provider has its own way of
	// being wrong — and the wrong-provider case is the one that would otherwise
	// launch quietly and serve multi-megabyte originals to every visitor.
	{
		name: 'the direct provider (unresized originals) on a real deploy',
		mutate: (env) => {
			env.IMAGE_PROVIDER = 'direct';
			delete env.CF_IMAGE_BASE_URL;
		},
		message: /IMAGE_PROVIDER=direct serves unresized originals/
	},
	{
		name: 'an unknown IMAGE_PROVIDER',
		mutate: (env) => (env.IMAGE_PROVIDER = 'imgix'),
		message: /IMAGE_PROVIDER=imgix is not one of/
	},
	{
		name: 'a cloudflare deploy with no public media origin',
		mutate: (env) => delete env.MEDIA_PUBLIC_BASE_URL,
		message: /IMAGE_PROVIDER=cloudflare needs: MEDIA_PUBLIC_BASE_URL/
	},
	{
		name: 'an imgproxy deploy missing its signing key',
		base: imgproxyProdEnv,
		mutate: (env) => delete env.IMGPROXY_KEY,
		message: /IMAGE_PROVIDER=imgproxy needs: IMGPROXY_KEY/
	},
	{
		name: 'an http media origin (mixed content)',
		mutate: (env) => (env.MEDIA_PUBLIC_BASE_URL = 'http://media.bettersleep.ro'),
		message: /MEDIA_PUBLIC_BASE_URL must be https/
	},
	{
		name: 'an unparseable media origin',
		mutate: (env) => (env.MEDIA_PUBLIC_BASE_URL = 'media.bettersleep.ro'),
		message: /MEDIA_PUBLIC_BASE_URL is not a valid URL/
	},
	{
		name: 'a test Stripe key in a live (EMAIL_DRYRUN=false) env',
		mutate: (env) => {
			env.STRIPE_SECRET_KEY = 'sk_test_123';
			env.STRIPE_WEBHOOK_SECRET = 'whsec_live_real';
			env.EMAIL_DRYRUN = 'false';
			env.RESEND_API_KEY = 're_live';
		},
		message: /STRIPE_SECRET_KEY is a TEST key/
	},
	{
		name: 'EMAIL_DRYRUN=false without a Resend key',
		mutate: (env) => (env.EMAIL_DRYRUN = 'false'),
		message: /RESEND_API_KEY is required when EMAIL_DRYRUN=false/
	},
	{
		name: 'CHAT_PROVIDER=anthropic without an API key',
		mutate: (env) => (env.CHAT_PROVIDER = 'anthropic'),
		message: /ANTHROPIC_API_KEY is required when CHAT_PROVIDER=anthropic/
	},
	{
		name: 'a cloudflare deploy without a private fiscal bucket',
		mutate: (env) => delete env.S3_INVOICE_BUCKET,
		message: /S3_INVOICE_BUCKET is required when IMAGE_PROVIDER=cloudflare/
	},
	{
		name: 'a fiscal bucket that is the media bucket',
		mutate: (env) => (env.S3_INVOICE_BUCKET = env.S3_BUCKET),
		message: /S3_INVOICE_BUCKET must not be the media bucket/
	},
	{
		name: 'a vercel target without CRON_SECRET',
		target: 'vercel',
		mutate: (env) => delete env.CRON_SECRET,
		message: /CRON_SECRET is not set \(required on the vercel target/
	},
	{
		name: 'a vercel target without DIRECT_DATABASE_URL',
		target: 'vercel',
		mutate: (env) => delete env.DIRECT_DATABASE_URL,
		message: /DIRECT_DATABASE_URL is not set \(required on the vercel target/
	}
];

describe('launch:check rules', () => {
	it('passes a complete prod-shaped env on the node target', () => {
		expect(launchCheckProblems(prodEnv(), { target: 'node' })).toEqual([]);
	});

	it('passes a complete prod-shaped env on the vercel target', () => {
		expect(launchCheckProblems(vercelEnv(), { target: 'vercel' })).toEqual([]);
	});

	it('passes a complete imgproxy (self-hosted) prod env too', () => {
		expect(launchCheckProblems(imgproxyProdEnv(), { target: 'node' })).toEqual([]);
	});

	it('an imgproxy deploy may derive the fiscal bucket (no public media origin)', () => {
		const env = imgproxyProdEnv();
		delete env.S3_INVOICE_BUCKET;
		expect(launchCheckProblems(env, { target: 'node' })).toEqual([]);
	});

	it.each(CASES)('flags $name', ({ target, base, mutate, message }) => {
		const env = base ? base() : target === 'vercel' ? vercelEnv() : prodEnv();
		mutate(env);
		const problems = launchCheckProblems(env, { target: target ?? 'node' });
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join('\n')).toMatch(message);
	});

	it('reports every problem in one pass, not just the first', () => {
		const env = prodEnv();
		delete env.S3_BUCKET;
		env.BETTER_AUTH_SECRET = 'dev-only-secret-change-me-0123456789';
		env.PUBLIC_SITE_URL = 'http://bettersleep.ro';
		expect(launchCheckProblems(env, { target: 'node' }).length).toBeGreaterThanOrEqual(3);
	});

	it('--dev acknowledges the dev defaults the local env ships with', () => {
		expect(launchCheckProblems(devEnv(), { target: 'node', dev: true })).toEqual([]);
		// … but the same env is NOT launch-worthy without the acknowledgement:
		expect(launchCheckProblems(devEnv(), { target: 'node' }).length).toBeGreaterThan(0);
	});

	it('--dev still enforces missing variables and conditional requirements', () => {
		const missing = devEnv();
		delete missing.DATABASE_URL;
		expect(launchCheckProblems(missing, { target: 'node', dev: true })).toEqual([
			'DATABASE_URL is not set'
		]);

		const anthropic = { ...devEnv(), CHAT_PROVIDER: 'anthropic' };
		expect(launchCheckProblems(anthropic, { target: 'node', dev: true })).toEqual([
			'ANTHROPIC_API_KEY is required when CHAT_PROVIDER=anthropic'
		]);
	});

	it('flags a half-configured analytics provider (it would 500 every public page)', () => {
		const half = { ...devEnv(), PUBLIC_ANALYTICS_PROVIDER: 'plausible' };
		expect(launchCheckProblems(half, { target: 'node', dev: true })).toEqual([
			'PUBLIC_ANALYTICS_PROVIDER=plausible requires PUBLIC_ANALYTICS_HOST and PUBLIC_ANALYTICS_SITE_ID to be set'
		]);

		const full = {
			...devEnv(),
			PUBLIC_ANALYTICS_PROVIDER: 'plausible',
			PUBLIC_ANALYTICS_HOST: 'https://plausible.io',
			PUBLIC_ANALYTICS_SITE_ID: 'bettersleep.ro'
		};
		expect(launchCheckProblems(full, { target: 'node', dev: true })).toEqual([]);
	});
});

describe('env matrix single-sourcing', () => {
	it('the boot validator derives its list from ENV_MATRIX', () => {
		expect(REQUIRED_BOOT_ENV).toEqual(ENV_MATRIX.filter((v) => v.boot).map((v) => v.name));
	});

	it('every boot var added to the matrix is seen by BOTH boot and launch:check', () => {
		const bootReport = bootEnvProblems({});
		const launchReport = launchCheckProblems({}, { target: 'node', dev: true });
		for (const name of REQUIRED_BOOT_ENV) {
			expect(bootReport).toContain(`${name} is not set`);
			expect(launchReport).toContain(`${name} is not set`);
		}
	});

	it('the vercel target requires exactly the boot vars plus the vercel extras', () => {
		expect(requiredEnvFor('node')).toEqual([...REQUIRED_BOOT_ENV]);
		expect(requiredEnvFor('vercel')).toEqual([
			...REQUIRED_BOOT_ENV,
			'DIRECT_DATABASE_URL',
			'CRON_SECRET'
		]);
	});

	it('every dev default declared in the matrix is flagged', () => {
		for (const spec of ENV_MATRIX) {
			for (const value of spec.devDefaults ?? []) {
				expect(devDefaultProblem(spec.name, value)).toMatch(/committed dev default/);
			}
			expect(devDefaultProblem(spec.name, 'a-genuinely-fresh-value')).toBeNull();
		}
	});
});

// Integration: against the compose stack (MinIO only — the suite runs without
// an image transformer). The probe uploads its own 1×1 PNG, so no fixture or
// database is needed.
//
// The Cloudflare half of the probe cannot be exercised against Cloudflare from
// here, and paying for a zone to run a test would be absurd. What IS testable —
// and what actually breaks in production — is the probe's own logic: that it
// reaches the public origin, that it does not mistake "transformations are off"
// for success, and that an unreachable host is reported rather than thrown. So
// MinIO plays the origin, and the transform URL deliberately has nowhere to go.
describe('image probe (integration)', () => {
	function cloudflareProbeEnv(overrides: Record<string, string | undefined> = {}) {
		const origin = `${process.env.S3_ENDPOINT?.replace(/\/$/, '')}/${process.env.S3_BUCKET}`;
		return {
			...process.env,
			IMAGE_PROVIDER: 'cloudflare',
			MEDIA_PUBLIC_BASE_URL: origin,
			CF_IMAGE_BASE_URL: origin,
			...overrides
		};
	}

	it('reaches the public origin and cleans up after itself', async () => {
		const problems = await probeImages(cloudflareProbeEnv());
		// The origin half must be silent: the object uploaded, was fetchable
		// anonymously, and was deleted (a cleanup failure reports separately).
		expect(problems.join('\n')).not.toMatch(/origin .* answered/);
		expect(problems.join('\n')).not.toMatch(/cleanup failed/);
	}, 20_000);

	// The silent killer: with transformations off, Cloudflare returns the source
	// untouched with a 200. Asking for webp and checking what came back is the
	// only way to tell "working" from "passing originals through".
	it('catches a transform endpoint that answers but does not transform', async () => {
		const problems = await probeImages(cloudflareProbeEnv());
		// MinIO answers the /cdn-cgi/image path with an error rather than a
		// transformed image; a real zone with transformations OFF answers 200
		// with the untouched source. Both must be reported, neither silently.
		expect(problems.join('\n')).toMatch(/Image Transformations are OFF|answered \d{3}/);
	}, 20_000);

	it('reports an unreachable origin instead of throwing', async () => {
		const problems = await probeImages(
			cloudflareProbeEnv({ MEDIA_PUBLIC_BASE_URL: 'http://localhost:1' })
		);
		expect(problems.join('\n')).toMatch(/is not reachable from here/);
	}, 20_000);

	// `direct` has no derivative to ask for, so the probe must decline rather
	// than invent an assertion — the env rules already refuse it for prod.
	it('declines to probe a non-transforming provider', () => {
		expect(imageProbeBlocker({ ...process.env, IMAGE_PROVIDER: 'direct' })).toMatch(
			/no transforms to probe/
		);
	});

	it('declines to probe when the storage credentials are incomplete', () => {
		expect(imageProbeBlocker({ ...process.env, S3_BUCKET: '' })).toMatch(/S3_\* incomplete/);
	});
});

// FIX-12 (audit P0 #4): whatever bucket is bound to the public media origin,
// nothing under `invoices/` may be readable there. Locally the media bucket
// IS public (the `direct` provider needs it), so the probe must report it —
// proof that the probe detects a leak, not a green built on a private MinIO.
describe('fiscal privacy probe (integration)', () => {
	function probeEnv(overrides: Record<string, string | undefined> = {}) {
		const origin = `${process.env.S3_ENDPOINT?.replace(/\/$/, '')}/${process.env.S3_BUCKET}`;
		return { ...process.env, MEDIA_PUBLIC_BASE_URL: origin, ...overrides };
	}

	it('reports a public media origin that serves invoices/, and cleans up', async () => {
		const problems = await probeFiscalPrivacy(probeEnv());
		expect(problems.join('\n')).toMatch(/invoices\/.* is PUBLICLY readable/);
		expect(problems.join('\n')).not.toMatch(/cleanup failed/);
	}, 20_000);

	it('reports an unreachable origin instead of throwing', async () => {
		const problems = await probeFiscalPrivacy(probeEnv({ MEDIA_PUBLIC_BASE_URL: 'http://localhost:1' }));
		expect(problems.join('\n')).toMatch(/is not reachable from here/);
	}, 20_000);

	it('declines to probe without a public media origin or storage credentials', () => {
		expect(fiscalProbeBlocker({ ...process.env, MEDIA_PUBLIC_BASE_URL: '' })).toMatch(
			/MEDIA_PUBLIC_BASE_URL is not set/
		);
		expect(fiscalProbeBlocker(probeEnv({ S3_BUCKET: '' }))).toMatch(/S3_\* incomplete/);
	});
});
