// Shared e2e environment: derives per-site database URLs from the root .env
// and defines the staff credentials the global setup seeds.
import { config } from 'dotenv';
import path from 'node:path';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

export const SITE_DB_NAMES = { sleep: 'better_sleep', life: 'better_life' } as const;

export function siteDatabaseUrl(siteId: keyof typeof SITE_DB_NAMES): string {
	const base = process.env.DATABASE_URL;
	if (!base) {
		throw new Error('DATABASE_URL is not set — start the database and configure the root .env');
	}
	const url = new URL(base);
	url.pathname = `/${SITE_DB_NAMES[siteId]}`;
	return url.toString();
}

export const E2E_ADMIN = { email: 'e2e-admin@example.com', password: 'e2e-admin-password-1' };
export const E2E_EDITOR = { email: 'e2e-editor@example.com', password: 'e2e-editor-password-1' };

// Webhook signing secret shared between the preview servers and the shop e2e
// (which constructs signed Stripe events with the SDK's offline test helper).
export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_e2e_test_secret';
