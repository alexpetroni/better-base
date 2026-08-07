import { describe, expect, it } from 'vitest';
import { bootEnvProblems, REQUIRED_BOOT_ENV } from './boot.ts';
import { devDefaultProblem, ENV_MATRIX, requiredEnvFor, type DeployTarget } from './env-matrix.ts';
import { canProbeImgproxy, launchCheckProblems, probeImgproxy } from './launch-check.ts';

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
		IMGPROXY_URL: 'https://img.bettersleep.ro',
		IMGPROXY_KEY: '0f'.repeat(32),
		IMGPROXY_SALT: 'a1'.repeat(32),
		EMAIL_DRYRUN: 'true'
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
		IMGPROXY_URL: 'http://localhost:8888',
		IMGPROXY_KEY: 'c3'.repeat(32),
		IMGPROXY_SALT: 'd4'.repeat(32),
		STRIPE_WEBHOOK_SECRET: 'whsec_dev_only_secret_change_me',
		EMAIL_DRYRUN: 'true',
		CHAT_PROVIDER: 'mock'
	};
}

// One case per rule — each defect must produce its own distinct failure.
const CASES: Array<{
	name: string;
	target?: DeployTarget;
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
		mutate: (env) => (env.IMGPROXY_KEY = 'aa'),
		message: /IMGPROXY_KEY does not look like a generated secret/
	},
	{
		name: 'an imgproxy salt equal to the key',
		mutate: (env) => (env.IMGPROXY_SALT = env.IMGPROXY_KEY),
		message: /IMGPROXY_SALT must differ from IMGPROXY_KEY/
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

	it.each(CASES)('flags $name', ({ target, mutate, message }) => {
		const env = target === 'vercel' ? vercelEnv() : prodEnv();
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

// Integration: against the compose stack (MinIO + imgproxy), like media.spec.ts.
// The probe uploads its own 1×1 PNG, so no fixture or database is needed.
describe('imgproxy probe (integration)', () => {
	it('passes against the local imgproxy: signed 200, unsigned 403', async () => {
		if (!canProbeImgproxy(process.env)) {
			throw new Error('IMGPROXY_*/S3_* env vars are not set — start `docker compose up -d`');
		}
		expect(await probeImgproxy(process.env)).toEqual([]);
	}, 20_000);

	it('detects a key/salt mismatch as the signed URL failing', async () => {
		const wrongKey = { ...process.env, IMGPROXY_KEY: 'deadbeef'.repeat(8) };
		const problems = await probeImgproxy(wrongKey);
		expect(problems.join('\n')).toMatch(/signed URL answered 403.*do not match/);
	}, 20_000);

	it('reports an unreachable imgproxy instead of throwing', async () => {
		const unreachable = { ...process.env, IMGPROXY_URL: 'http://localhost:1' };
		const problems = await probeImgproxy(unreachable);
		expect(problems.join('\n')).toMatch(/is not reachable from here/);
	}, 20_000);
});
