import { describe, expect, it } from 'vitest';
import { assertBootEnv, bootEnvProblems, REQUIRED_BOOT_ENV } from './boot.ts';

/** A minimal env every check passes on; tests knock single values out. */
function validEnv(): Record<string, string | undefined> {
	return {
		SITE_ID: 'sleep',
		DATABASE_URL: 'postgres://x/db',
		PUBLIC_SITE_URL: 'http://localhost:5173',
		BETTER_AUTH_SECRET: 'auth-secret',
		TOKEN_SECRET: 'token-secret',
		S3_ENDPOINT: 'http://localhost:9000',
		S3_ACCESS_KEY: 'ak',
		S3_SECRET_KEY: 'sk',
		S3_BUCKET: 'bucket',
		IMGPROXY_URL: 'http://localhost:8888',
		IMGPROXY_KEY: 'aa',
		IMGPROXY_SALT: 'bb',
		EMAIL_DRYRUN: 'true'
	};
}

describe('boot env validation (audit resilience #10)', () => {
	it('accepts a complete env', () => {
		expect(bootEnvProblems(validEnv())).toEqual([]);
		expect(() => assertBootEnv(validEnv())).not.toThrow();
	});

	it.each(REQUIRED_BOOT_ENV)('refuses to boot without %s, naming it', (name) => {
		const env = validEnv();
		delete env[name];
		expect(bootEnvProblems(env)).toEqual([`${name} is not set`]);
		expect(() => assertBootEnv(env)).toThrow(new RegExp(`Refusing to start[\\s\\S]*${name}`));
	});

	it('treats empty strings as unset', () => {
		const env = { ...validEnv(), IMGPROXY_KEY: '' };
		expect(bootEnvProblems(env)).toEqual(['IMGPROXY_KEY is not set']);
	});

	it('requires RESEND_API_KEY at boot when EMAIL_DRYRUN=false — not at first send', () => {
		const env = { ...validEnv(), EMAIL_DRYRUN: 'false' };
		expect(bootEnvProblems(env)).toEqual(['RESEND_API_KEY is required when EMAIL_DRYRUN=false']);
		expect(bootEnvProblems({ ...env, RESEND_API_KEY: 're_x' })).toEqual([]);
	});

	it('requires STRIPE_WEBHOOK_SECRET when a real Stripe key is configured', () => {
		const env = { ...validEnv(), STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: '' };
		expect(bootEnvProblems(env)).toEqual([
			'STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set'
		]);
	});

	it('refuses TOKEN_SECRET === BETTER_AUTH_SECRET', () => {
		const env = { ...validEnv(), TOKEN_SECRET: 'auth-secret' };
		expect(bootEnvProblems(env)).toEqual(['TOKEN_SECRET must differ from BETTER_AUTH_SECRET']);
	});

	it('reports every problem in one pass', () => {
		const env = validEnv();
		delete env.DATABASE_URL;
		delete env.S3_BUCKET;
		env.EMAIL_DRYRUN = 'false';
		expect(bootEnvProblems(env)).toEqual([
			'DATABASE_URL is not set',
			'S3_BUCKET is not set',
			'RESEND_API_KEY is required when EMAIL_DRYRUN=false'
		]);
	});
});
