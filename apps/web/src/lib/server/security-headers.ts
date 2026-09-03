import { directOriginFromEnv } from '../modules/media/env.ts';

/**
 * Security headers + the HOST-DEPENDENT half of the CSP (audit 2026-09-03,
 * "no security headers / CSP anywhere"). Framework-free and pure so every
 * rule is unit-testable; hooks.server.ts applies the result to each response.
 *
 * The STATIC half of the CSP lives in `kit.csp` (vite.config.ts): script-src
 * 'self' 'strict-dynamic' (SvelteKit nonces its bootstrap; the DOM-injected
 * analytics script is trusted transitively), style-src 'self' 'unsafe-inline'
 * (inline theme/blurhash/score-bar styles), object-src 'none', base-uri
 * 'self'. Everything derived from env — image origins, the analytics host,
 * the bucket endpoint — is appended here at runtime, because a build must
 * not bake one deployment's hosts into another's headers.
 */

export interface SecurityHeadersEnv {
	PUBLIC_SITE_URL?: string;
	MEDIA_PUBLIC_BASE_URL?: string;
	IMGPROXY_URL?: string;
	CF_IMAGE_BASE_URL?: string;
	S3_ENDPOINT?: string;
	S3_BUCKET?: string;
	PUBLIC_ANALYTICS_HOST?: string;
}

/** The two hosts the markdown sanitizer allows video iframes from (blog/markdown.ts). */
export const FRAME_SRC_HOSTS = [
	'https://www.youtube-nocookie.com',
	'https://iframe.mediadelivery.net'
] as const;

/** The URL's origin, or null for empty/unparseable values. */
export function originOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/** Ordered de-dupe that drops nulls — CSP source lists must not repeat. */
function sources(...candidates: Array<string | null>): string[] {
	return [...new Set(candidates.filter((c): c is string => c !== null))];
}

/**
 * The env-derived CSP directives, ready to append after the kit-rendered
 * static half. `isAdmin` widens connect-src with the bucket endpoint — the
 * admin media page PUTs uploads there directly; no public page may.
 */
export function runtimeCspDirectives(
	env: SecurityHeadersEnv,
	opts: { isAdmin: boolean }
): string {
	const imgSrc = sources(
		"'self'",
		'data:',
		originOf(directOriginFromEnv(env)),
		originOf(env.IMGPROXY_URL),
		originOf(env.CF_IMAGE_BASE_URL)
	);
	const connectSrc = sources(
		"'self'",
		originOf(env.PUBLIC_ANALYTICS_HOST),
		opts.isAdmin ? originOf(env.S3_ENDPOINT) : null
	);
	return [
		`img-src ${imgSrc.join(' ')}`,
		`connect-src ${connectSrc.join(' ')}`,
		`frame-src ${FRAME_SRC_HOSTS.join(' ')}`,
		// Chrome enforces form-action on the 303 target of a form POST — the
		// checkout redirect to Stripe would be blocked without its origin here.
		`form-action 'self' https://checkout.stripe.com`,
		`frame-ancestors 'none'`
	].join('; ');
}

/**
 * Mutates `response` with the full header set. Kit's CSP header (when the
 * response is a rendered page) is preserved and the runtime half appended;
 * responses without one (endpoints, static) get the runtime half alone.
 */
export function applySecurityHeaders(
	response: Response,
	env: SecurityHeadersEnv,
	opts: { isAdmin: boolean }
): void {
	const headers = response.headers;
	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	// Redundant with frame-ancestors for CSP-aware browsers; kept for the rest.
	headers.set('x-frame-options', 'DENY');
	headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	if (env.PUBLIC_SITE_URL?.startsWith('https://')) {
		headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	}
	if (opts.isAdmin) {
		// Staff pages carry PII — shared caches and disk caches stay out.
		headers.set('cache-control', 'private, no-store');
	}

	const runtime = runtimeCspDirectives(env, opts);
	const existing = headers.get('content-security-policy');
	headers.set('content-security-policy', existing ? `${existing}; ${runtime}` : runtime);
}
