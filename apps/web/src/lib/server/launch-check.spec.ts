import { describe, expect, it } from 'vitest';
import { bootEnvProblems, REQUIRED_BOOT_ENV } from './boot.ts';
import { devDefaultProblem, ENV_MATRIX, requiredEnvFor, type DeployTarget } from './env-matrix.ts';
import {
	fiscalProbeBlocker,
	imageProbeBlocker,
	launchCheckProblems,
	launchCheckWarnings,
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
		// FIX-16: an EMPTY key is the in-memory mock gateway — never prod-worthy.
		STRIPE_SECRET_KEY: 'sk_live_123',
		STRIPE_WEBHOOK_SECRET: 'whsec_real_value',
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
		CRON_SECRET: 'b2'.repeat(32),
		DB_DRIVER: 'neon',
		ERROR_REPORT_URL: 'https://sink.example.com/ingest'
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
	// FIX-14 (audit P2): a mock provider in production is otherwise undetectable.
	{
		name: 'a live env (EMAIL_DRYRUN=false) still on the mock chat provider',
		mutate: (env) => {
			liveEnv(env);
			delete env.CHAT_PROVIDER;
		},
		message: /CHAT_PROVIDER is "mock" in a live env \(EMAIL_DRYRUN=false\)/
	},
	{
		name: 'a live env (EMAIL_DRYRUN=false) still on the mock courier',
		mutate: (env) => {
			liveEnv(env);
			env.COURIER_PROVIDER = 'mock';
		},
		message: /COURIER_PROVIDER is "mock" in a live env \(EMAIL_DRYRUN=false\)/
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
	},
	// FIX-16 (audit "launch:check blesses a deploy whose shop is a mock"): an
	// empty key selects the in-memory mock gateway, which "takes" orders per
	// function instance and never sees a webhook.
	{
		name: 'an empty STRIPE_SECRET_KEY (the mock gateway)',
		mutate: (env) => (env.STRIPE_SECRET_KEY = ''),
		message: /STRIPE_SECRET_KEY is empty — the shop would run on the in-memory MOCK gateway/
	},
	{
		name: 'an unset STRIPE_SECRET_KEY (the mock gateway)',
		mutate: (env) => delete env.STRIPE_SECRET_KEY,
		message: /STRIPE_SECRET_KEY is empty — the shop would run on the in-memory MOCK gateway/
	},
	// The neon driver holds one WebSocket per process — on a long-lived node
	// server that is the whole site behind a single connection.
	{
		name: 'the neon driver on the node target',
		target: 'node',
		mutate: (env) => (env.DB_DRIVER = 'neon'),
		message: /DB_DRIVER=neon on the node target/
	}
];

/** Flip a prod-shaped env to live mode with real providers everywhere. */
function liveEnv(env: Record<string, string | undefined>): void {
	env.EMAIL_DRYRUN = 'false';
	env.RESEND_API_KEY = 're_live';
	env.STRIPE_SECRET_KEY = 'sk_live_123';
	env.STRIPE_WEBHOOK_SECRET = 'whsec_live_real';
	env.CHAT_PROVIDER = 'anthropic';
	env.ANTHROPIC_API_KEY = 'sk-ant-live';
	env.COURIER_PROVIDER = 'sameday';
	env.SAMEDAY_USERNAME = 'user';
	env.SAMEDAY_PASSWORD = 'pass';
	env.SAMEDAY_PICKUP_POINT = '1';
}

describe('launch:check mock-provider rule (FIX-14)', () => {
	const mockProviderProblems = (problems: string[]) =>
		problems.filter((p) => /in a live env \(EMAIL_DRYRUN=false\)/.test(p));

	it('passes a live env on real providers', () => {
		const env = prodEnv();
		liveEnv(env);
		expect(launchCheckProblems(env, { target: 'node' })).toEqual([]);
	});

	it('reports both mock providers in one pass', () => {
		const env = prodEnv();
		liveEnv(env);
		env.CHAT_PROVIDER = 'mock';
		env.COURIER_PROVIDER = 'mock';
		const problems = mockProviderProblems(launchCheckProblems(env, { target: 'node' }));
		expect(problems).toHaveLength(2);
		expect(problems.join('\n')).toMatch(/--allow-mock-providers/);
	});

	it('--allow-mock-providers acknowledges mocks in a live env', () => {
		const env = prodEnv();
		liveEnv(env);
		env.CHAT_PROVIDER = 'mock';
		env.COURIER_PROVIDER = 'mock';
		expect(launchCheckProblems(env, { target: 'node', allowMockProviders: true })).toEqual([]);
	});

	it('does not fire while EMAIL_DRYRUN=true (staging on mocks is the normal state)', () => {
		const env = prodEnv();
		env.CHAT_PROVIDER = 'mock';
		env.COURIER_PROVIDER = 'mock';
		expect(mockProviderProblems(launchCheckProblems(env, { target: 'node' }))).toEqual([]);
	});
});

// Review 2026-09-05 #3: a production deploy that never flipped EMAIL_DRYRUN
// takes paid orders and sends nothing — every send is a silent `dryrun` row.
describe('launch:check dry-run email rule (FIX-18)', () => {
	const dryRunProblems = (problems: string[]) => problems.filter((p) => /EMAIL_DRYRUN/.test(p));

	it('the unmodified production fixture (EMAIL_DRYRUN=true) is a problem outside --dev', () => {
		const problems = dryRunProblems(launchCheckProblems(prodEnv(), { target: 'node' }));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/EMAIL_DRYRUN.*true.*no email/i);
		expect(problems[0]).toMatch(/--allow-mock-providers/);
	});

	it('an unset EMAIL_DRYRUN is the same silent state (the sender defaults to dry-run)', () => {
		const env = prodEnv();
		delete env.EMAIL_DRYRUN;
		expect(dryRunProblems(launchCheckProblems(env, { target: 'node' }))).toHaveLength(1);
	});

	it('--allow-mock-providers acknowledges a dry-run rehearsal on purpose', () => {
		expect(launchCheckProblems(prodEnv(), { target: 'node', allowMockProviders: true })).toEqual(
			[]
		);
		expect(
			launchCheckProblems(vercelEnv(), { target: 'vercel', allowMockProviders: true })
		).toEqual([]);
	});

	it('is silent once the env is live (EMAIL_DRYRUN=false) and under --dev', () => {
		const env = prodEnv();
		liveEnv(env);
		expect(dryRunProblems(launchCheckProblems(env, { target: 'node' }))).toEqual([]);
		expect(dryRunProblems(launchCheckProblems(devEnv(), { target: 'node', dev: true }))).toEqual(
			[]
		);
	});
});

describe('launch:check warnings (FIX-16)', () => {
	it('a complete vercel env warns about nothing', () => {
		expect(launchCheckWarnings(vercelEnv(), { target: 'vercel' })).toEqual([]);
	});

	it('warns on the vercel target without the neon driver (pg pools churn per function)', () => {
		const env = vercelEnv();
		delete env.DB_DRIVER;
		expect(launchCheckWarnings(env, { target: 'vercel' })).toEqual([
			expect.stringMatching(/DB_DRIVER is not neon on the vercel target/)
		]);
	});

	it('warns on the neon driver with DB_POOL_MAX above 2', () => {
		const env = { ...vercelEnv(), DB_POOL_MAX: '10' };
		expect(launchCheckWarnings(env, { target: 'vercel' })).toEqual([
			expect.stringMatching(/DB_POOL_MAX=10 with DB_DRIVER=neon/)
		]);
		expect(launchCheckWarnings({ ...vercelEnv(), DB_POOL_MAX: '2' }, { target: 'vercel' })).toEqual(
			[]
		);
	});

	it('warns when no error sink is configured outside --dev', () => {
		const env = prodEnv();
		expect(launchCheckWarnings(env, { target: 'node' })).toEqual([
			expect.stringMatching(/ERROR_REPORT_URL is not set/)
		]);
		expect(launchCheckWarnings(env, { target: 'node', dev: true })).toEqual([]);
	});

	it('--dev still warns about a driver/target mismatch', () => {
		const env = { ...vercelEnv(), DB_POOL_MAX: '5' };
		expect(launchCheckWarnings(env, { target: 'vercel', dev: true })).toEqual([
			expect.stringMatching(/DB_POOL_MAX=5 with DB_DRIVER=neon/)
		]);
	});
});

describe('launch:check rules', () => {
	it('--dev accepts an empty STRIPE_SECRET_KEY (the mock gateway is the dev default)', () => {
		const env = devEnv();
		env.STRIPE_SECRET_KEY = '';
		expect(launchCheckProblems(env, { target: 'node', dev: true })).toEqual([]);
	});

	// The fixtures rehearse on dry-run email (EMAIL_DRYRUN=true), which FIX-18
	// makes a problem unless acknowledged — so these pass the acknowledgement
	// and keep asserting that nothing ELSE is wrong with a complete env.
	const acknowledged = { allowMockProviders: true } as const;

	it('passes a complete prod-shaped env on the node target', () => {
		expect(launchCheckProblems(prodEnv(), { target: 'node', ...acknowledged })).toEqual([]);
	});

	it('passes a complete prod-shaped env on the vercel target', () => {
		expect(launchCheckProblems(vercelEnv(), { target: 'vercel', ...acknowledged })).toEqual([]);
	});

	it('passes a complete imgproxy (self-hosted) prod env too', () => {
		expect(launchCheckProblems(imgproxyProdEnv(), { target: 'node', ...acknowledged })).toEqual(
			[]
		);
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
		const problems = await probeFiscalPrivacy(
			probeEnv({ MEDIA_PUBLIC_BASE_URL: 'http://localhost:1' })
		);
		expect(problems.join('\n')).toMatch(/is not reachable from here/);
	}, 20_000);

	it('declines to probe without a public media origin or storage credentials', () => {
		expect(fiscalProbeBlocker({ ...process.env, MEDIA_PUBLIC_BASE_URL: '' })).toMatch(
			/MEDIA_PUBLIC_BASE_URL is not set/
		);
		expect(fiscalProbeBlocker(probeEnv({ S3_BUCKET: '' }))).toMatch(/S3_\* incomplete/);
	});
});
