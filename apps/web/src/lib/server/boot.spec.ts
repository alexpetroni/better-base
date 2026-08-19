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
		// Image delivery is provider-selected: no IMAGE_PROVIDER means `direct`,
		// and the origin is stated explicitly so knocking out an S3_* variable
		// tests exactly one rule instead of cascading into the provider check.
		MEDIA_PUBLIC_BASE_URL: 'http://localhost:9000/bucket',
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
		const env = { ...validEnv(), S3_ACCESS_KEY: '' };
		expect(bootEnvProblems(env)).toEqual(['S3_ACCESS_KEY is not set']);
	});

	// Every page renders images, so a provider that cannot be built is a dead
	// site. Which variables that needs depends on IMAGE_PROVIDER, which is why
	// the check builds the provider instead of consulting a fixed list.
	describe('image provider', () => {
		it('accepts the default (direct) derived from the S3 endpoint alone', () => {
			const env = validEnv();
			delete env.MEDIA_PUBLIC_BASE_URL;
			expect(bootEnvProblems(env)).toEqual([]);
		});

		it('refuses an unknown provider name', () => {
			expect(bootEnvProblems({ ...validEnv(), IMAGE_PROVIDER: 'imgix' })).toEqual([
				'IMAGE_PROVIDER=imgix is not one of cloudflare, imgproxy, direct — see DEPLOYMENT.md §6'
			]);
		});

		it('names what cloudflare is missing', () => {
			const env: Record<string, string | undefined> = {
				...validEnv(),
				IMAGE_PROVIDER: 'cloudflare'
			};
			delete env.MEDIA_PUBLIC_BASE_URL;
			expect(bootEnvProblems(env)).toEqual([
				'IMAGE_PROVIDER=cloudflare needs: MEDIA_PUBLIC_BASE_URL'
			]);
		});

		it('accepts a complete cloudflare config', () => {
			expect(
				bootEnvProblems({
					...validEnv(),
					IMAGE_PROVIDER: 'cloudflare',
					MEDIA_PUBLIC_BASE_URL: 'https://media.example.test'
				})
			).toEqual([]);
		});

		// The imgproxy pair is only required when imgproxy is the one selected —
		// demanding it from a Cloudflare deploy was the old, wrong behaviour.
		it('requires the imgproxy pair only under IMAGE_PROVIDER=imgproxy', () => {
			expect(bootEnvProblems({ ...validEnv(), IMGPROXY_URL: undefined })).toEqual([]);
			expect(
				bootEnvProblems({ ...validEnv(), IMAGE_PROVIDER: 'imgproxy', IMGPROXY_URL: 'http://x' })
			).toEqual(['IMAGE_PROVIDER=imgproxy needs: IMGPROXY_KEY, IMGPROXY_SALT']);
		});
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

	it('refuses ANAF_EFACTURA_ENABLED while SPV submission is unimplemented', () => {
		const env = { ...validEnv(), ANAF_EFACTURA_ENABLED: 'true' };
		expect(bootEnvProblems(env)).toEqual([
			'ANAF_EFACTURA_ENABLED is set but SPV submission is not implemented (see DEPLOYMENT.md §7 "Fiscal documents") — unset it'
		]);
		expect(bootEnvProblems({ ...validEnv(), ANAF_EFACTURA_ENABLED: 'false' })).toEqual([]);
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
