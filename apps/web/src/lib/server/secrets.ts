/**
 * Dedicated HMAC secret for app-signed tokens (newsletter consent links, chat
 * session cookies, upload-confirm tickets). Deliberately NOT the better-auth
 * session secret: a leak of one must not compromise the other (audit L5).
 * Framework-free: the env record is passed in, so this is unit-testable and
 * usable from scripts.
 */
export function tokenSecretFrom(env: Record<string, string | undefined>): string {
	if (!env.TOKEN_SECRET) {
		throw new Error(
			'TOKEN_SECRET is not set — dedicated secret for consent/chat/upload tokens (generate with `openssl rand -base64 32`)'
		);
	}
	if (env.BETTER_AUTH_SECRET && env.TOKEN_SECRET === env.BETTER_AUTH_SECRET) {
		throw new Error(
			'TOKEN_SECRET must differ from BETTER_AUTH_SECRET — reusing one secret for auth sessions and signed tokens is what it exists to prevent'
		);
	}
	return env.TOKEN_SECRET;
}
