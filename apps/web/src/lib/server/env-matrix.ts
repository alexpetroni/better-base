/**
 * THE environment matrix: the single declaration of which variables a deploy
 * needs, which extras the Vercel target needs, and which committed dev-default
 * values must never reach a production environment.
 *
 * Both consumers derive from this list — never grow a second one that can
 * drift:
 *   - `boot.ts` (fail-fast boot validation inside the app) takes the
 *     `boot: true` entries;
 *   - `launch-check.ts` (`pnpm launch:check`, the pre-deploy preflight) takes
 *     everything, including the Vercel extras and the dev-default scans.
 *
 * DEPLOYMENT.md §2 and §12 document what each variable does.
 */

export type DeployTarget = 'node' | 'vercel';

export interface EnvVarSpec {
	/** Variable name as it appears in the environment. */
	name: string;
	/** Required at boot on every deploy target (drives REQUIRED_BOOT_ENV). */
	boot?: boolean;
	/** Additionally required for a Vercel deploy (checked by launch:check). */
	vercel?: boolean;
	/** Committed dev-default values (.env.example / compose) — never prod-worthy. */
	devDefaults?: readonly string[];
	/** Patterns marking a dev value inside a larger one (compose credentials in a URL). */
	devDefaultPatterns?: readonly RegExp[];
}

/** docker-compose.yml's local Postgres credentials, as they appear in a URL. */
const COMPOSE_DB_CREDENTIALS = /\/\/better:better@/;

export const ENV_MATRIX: readonly EnvVarSpec[] = [
	{ name: 'SITE_ID', boot: true },
	{ name: 'DATABASE_URL', boot: true, devDefaultPatterns: [COMPOSE_DB_CREDENTIALS] },
	{ name: 'PUBLIC_SITE_URL', boot: true },
	{
		name: 'BETTER_AUTH_SECRET',
		boot: true,
		devDefaults: ['dev-only-secret-change-me-0123456789']
	},
	{
		name: 'TOKEN_SECRET',
		boot: true,
		devDefaults: ['dev-only-token-secret-change-me-9876543210']
	},
	{ name: 'S3_ENDPOINT', boot: true },
	{ name: 'S3_ACCESS_KEY', boot: true, devDefaults: ['better-media'] },
	{ name: 'S3_SECRET_KEY', boot: true, devDefaults: ['better-media-secret'] },
	{ name: 'S3_BUCKET', boot: true },
	// The private fiscal-document bucket (FIX-12). Derived (`<S3_BUCKET>-fiscal`)
	// when unset; launch-check.ts requires it explicitly under the cloudflare
	// provider, where the media bucket is publicly bound.
	{ name: 'S3_INVOICE_BUCKET' },
	// Image delivery is provider-selected (DEPLOYMENT.md §6), so none of these
	// can be a flat boot requirement: a Cloudflare deploy has no imgproxy key
	// and an imgproxy deploy has no public media origin. `boot.ts` validates
	// them by BUILDING the selected provider (`imageProviderFromEnv`), which is
	// the one place that knows what each provider reads. They stay listed here
	// so the dev-default scan and the docs still cover them.
	{ name: 'IMAGE_PROVIDER' },
	{ name: 'MEDIA_PUBLIC_BASE_URL' },
	{ name: 'CF_IMAGE_BASE_URL' },
	{ name: 'IMGPROXY_URL' },
	// The imgproxy pair has NO committed defaults on purpose (compose refuses
	// to start without one) — weak/reused values are caught by shape checks in
	// launch-check.ts and by the live signature probe, not by a value list.
	{ name: 'IMGPROXY_KEY' },
	{ name: 'IMGPROXY_SALT' },
	// Not required at boot (only when STRIPE_SECRET_KEY is set — see boot.ts),
	// but its committed dev value must still never reach a production env:
	{ name: 'STRIPE_WEBHOOK_SECRET', devDefaults: ['whsec_dev_only_secret_change_me'] },
	// Vercel extras: migrations need an unpooled connection past PgBouncer, and
	// Vercel Cron authenticates against the retention route with the bearer
	// secret (DEPLOYMENT.md §12).
	{ name: 'DIRECT_DATABASE_URL', vercel: true, devDefaultPatterns: [COMPOSE_DB_CREDENTIALS] },
	{ name: 'CRON_SECRET', vercel: true },
	// Observability (FIX-16): optional error sink and the request log switch.
	// Neither is required anywhere; launch:check WARNS when the sink is unset
	// so a production deploy without one is a decision, not an oversight.
	{ name: 'ERROR_REPORT_URL' },
	{ name: 'LOG_REQUESTS' }
];

/** Variable names required for a deploy target (boot vars, plus Vercel extras). */
export function requiredEnvFor(target: DeployTarget): string[] {
	return ENV_MATRIX.filter((v) => v.boot || (target === 'vercel' && v.vercel)).map((v) => v.name);
}

/** Why `value` is a known dev default for `name`, or null when it is not. */
export function devDefaultProblem(name: string, value: string | undefined): string | null {
	const spec = ENV_MATRIX.find((v) => v.name === name);
	if (!spec || !value) return null;
	if (spec.devDefaults?.includes(value)) {
		return `${name} is the committed dev default — generate a real per-deploy value (see .env.example)`;
	}
	if (spec.devDefaultPatterns?.some((pattern) => pattern.test(value))) {
		return `${name} carries the local compose credentials — set the production connection string`;
	}
	return null;
}
