/**
 * Cross-site form-submission check, hook-level (audit 2026-09-03 P1).
 *
 * SvelteKit's built-in `csrf.checkOrigin` refuses EVERY form-encoded mutation
 * whose Origin is missing or foreign — including the RFC 8058 one-click
 * unsubscribe POST that mail clients send (`List-Unsubscribe=One-Click`,
 * `application/x-www-form-urlencoded`, no Origin header). The built-in check
 * is therefore disabled in vite.config.ts and re-implemented here with the
 * SAME rule (form content types, mutating methods, origin must equal the
 * request origin) plus exactly one exemption: the unsubscribe route, where the
 * per-subscriber token in the URL is the credential and a cross-site POST can
 * do nothing a direct POST could not.
 */

const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
];
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Route ids (group segments stripped) that accept cross-site form POSTs by design. */
export const CSRF_EXEMPT_ROUTES: readonly string[] = ['/unsubscribe/[token]'];

export function isFormContentType(request: Request): boolean {
	const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
	return FORM_CONTENT_TYPES.includes(type);
}

/** Should this request be refused as a cross-site form submission? */
export function isForbiddenCrossSiteForm(
	request: Request,
	url: URL,
	routePathname: string
): boolean {
	if (!MUTATING_METHODS.includes(request.method)) return false;
	if (!isFormContentType(request)) return false;
	if (CSRF_EXEMPT_ROUTES.includes(routePathname)) return false;
	return request.headers.get('origin') !== url.origin;
}
