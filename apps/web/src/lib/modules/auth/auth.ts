import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthPlugin } from 'better-auth';
import type { Db } from '../../db/client.ts';

export const MIN_PASSWORD_LENGTH = 12;

export interface CreateAuthOptions {
	db: Db;
	secret: string;
	/** Canonical origin (PUBLIC_SITE_URL). https → secure session cookies. */
	baseURL?: string;
	/** SvelteKit-only plugins (sveltekitCookies) — omitted in CLI/tests. */
	plugins?: BetterAuthPlugin[];
}

/**
 * Framework-free better-auth factory: no $env/$app imports so the user:create
 * CLI and integration tests can construct an instance directly. The app uses
 * the lazy `getAuth()` wrapper in server.ts.
 *
 * Session cookie is httpOnly + SameSite=lax always; Secure is derived by
 * better-auth from an https baseURL (i.e. secure in production).
 */
export function createAuth({ db, secret, baseURL, plugins }: CreateAuthOptions) {
	return betterAuth({
		secret,
		baseURL,
		database: drizzleAdapter(db, { provider: 'pg', usePlural: true }),
		emailAndPassword: {
			enabled: true,
			// Staff-only platform: users come from the CLI or an admin, never signup.
			disableSignUp: true,
			minPasswordLength: MIN_PASSWORD_LENGTH
		},
		user: {
			additionalFields: {
				role: {
					type: ['admin', 'editor'],
					required: false,
					defaultValue: 'editor',
					// Never accepted from request input — set only server-side.
					input: false
				}
			}
		},
		plugins
	});
}

export type Auth = ReturnType<typeof createAuth>;
