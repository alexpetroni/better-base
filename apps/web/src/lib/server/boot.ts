/**
 * Fail-fast boot validation (audit resilience #10): every env var the app
 * needs to serve its first request is checked ONCE at startup, so a
 * misconfigured deploy refuses to boot with one clear message instead of
 * booting "healthy" and 500ing on first use. Framework-free: the env record
 * is passed in (hooks.server.ts passes $env/dynamic/private + PUBLIC_SITE_URL).
 */

export const REQUIRED_BOOT_ENV = [
	'SITE_ID',
	'DATABASE_URL',
	'PUBLIC_SITE_URL',
	'BETTER_AUTH_SECRET',
	'TOKEN_SECRET',
	'S3_ENDPOINT',
	'S3_ACCESS_KEY',
	'S3_SECRET_KEY',
	'S3_BUCKET',
	'IMGPROXY_URL',
	'IMGPROXY_KEY',
	'IMGPROXY_SALT'
] as const;

/** Every problem found, or an empty list when the env is boot-worthy. */
export function bootEnvProblems(env: Record<string, string | undefined>): string[] {
	const problems = REQUIRED_BOOT_ENV.filter((name) => !env[name]).map(
		(name) => `${name} is not set`
	);

	// Real email delivery must fail at boot, not at the first send.
	if (env.EMAIL_DRYRUN === 'false' && !env.RESEND_API_KEY) {
		problems.push('RESEND_API_KEY is required when EMAIL_DRYRUN=false');
	}
	// A real Stripe gateway without a webhook secret would take payments whose
	// webhooks are all rejected — orders would never be created.
	if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
		problems.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set');
	}
	if (env.TOKEN_SECRET && env.TOKEN_SECRET === env.BETTER_AUTH_SECRET) {
		problems.push('TOKEN_SECRET must differ from BETTER_AUTH_SECRET');
	}
	// CHAT_PROVIDER=anthropic without a key is already rejected by the chat
	// provider's own boot check (modules/chat/server.ts) — not duplicated here.

	return problems;
}

/** Throw with every problem listed, so a broken deploy is fixed in one pass. */
export function assertBootEnv(env: Record<string, string | undefined>): void {
	const problems = bootEnvProblems(env);
	if (problems.length) {
		throw new Error(
			`Refusing to start — invalid environment:\n  - ${problems.join('\n  - ')}\nSee .env.example / DEPLOYMENT.md for every variable.`
		);
	}
}
