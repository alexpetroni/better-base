import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getRequestEvent } from '$app/server';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getDb } from '$lib/db';
import { createAuth, type Auth } from './auth.ts';

let instance: Auth | undefined;

/**
 * The app's better-auth instance. Lazy so build/analysis never needs env or a
 * DB connection. The sveltekitCookies plugin makes server-side `auth.api`
 * calls (sign-in/sign-out in form actions) set cookies on the active request.
 */
export function getAuth(): Auth {
	if (!instance) {
		if (!env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is not set');
		instance = createAuth({
			db: getDb(),
			secret: env.BETTER_AUTH_SECRET,
			baseURL: publicEnv.PUBLIC_SITE_URL,
			plugins: [sveltekitCookies(getRequestEvent)]
		});
	}
	return instance;
}
