import { error, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { getDb } from '$lib/db';
import { getAuth, guardAdminPath, isStaffRole, routeIdPathname } from '$lib/modules/auth';
import { createSettingsLoader } from '$lib/modules/settings/server';
import { assertBootEnv } from '$lib/server/boot';
import { formatServerError } from '$lib/server/log';
import { applySecurityHeaders } from '$lib/server/security-headers';
// Side effect: selects the chat provider at boot — CHAT_PROVIDER=anthropic
// without an ANTHROPIC_API_KEY fails fast instead of at the first message.
import '$lib/modules/chat/server';

// Fail fast (audit resilience #10): refuse to boot on missing required env
// instead of 500ing on first use. PUBLIC_SITE_URL lives in the public env.
assertBootEnv({ ...env, PUBLIC_SITE_URL: publicEnv.PUBLIC_SITE_URL });

/**
 * Security headers + the env-derived CSP half on every response (audit
 * 2026-09-03: no headers/CSP anywhere). FIRST in the sequence so it wraps
 * the others and stamps the final response on the way out; the static CSP
 * half (script-src/style-src/…) is rendered by kit.csp in vite.config.ts
 * and preserved by the append. See $lib/server/security-headers.
 */
const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const pathname = routeIdPathname(event.route.id);
	applySecurityHeaders(
		response,
		{ ...env, ...publicEnv },
		{ isAdmin: pathname === '/admin' || pathname.startsWith('/admin/') }
	);
	return response;
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;

		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
		});
	});

/**
 * Request-scoped site settings: a lazy loader every load function shares, so
 * however many of them ask, the request costs at most ONE settings query —
 * and nothing is cached across requests (a save is visible on the next one,
 * also on serverless instances).
 */
const handleSettings: Handle = ({ event, resolve }) => {
	event.locals.settings = createSettingsLoader(getDb);
	return resolve(event);
};

/**
 * Server-side protection for everything under /admin (except /admin/login):
 * anonymous → redirect to login; editor on an admin-only section → 403.
 * Session lookup is skipped entirely for public routes — except the fiscal
 * document downloads (/api/invoices/…), which serve BOTH audiences: staff by
 * session, customers by signed token. The route itself decides; the hook only
 * resolves who is asking.
 */
const handleAdminGuard: Handle = async ({ event, resolve }) => {
	event.locals.user = null;

	// Guard decisions key on the RESOLVED route id, never on url.pathname:
	// SvelteKit matches routes on the percent-decoded path, so '/%61dmin/…'
	// reaches the /admin route while the raw pathname reads '/%61dmin/…'
	// (audit 2026-09-03 P0 #1). An unmatched path ('' here) needs no guard —
	// there is no route to protect and the 404 answers it.
	const pathname = routeIdPathname(event.route.id);
	const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/');
	// /api/shipments serves only staff (AWB labels), so it needs the session too.
	if (
		isAdminPath ||
		pathname.startsWith('/api/invoices/') ||
		pathname.startsWith('/api/shipments/')
	) {
		const session = await getAuth().api.getSession({ headers: event.request.headers });
		if (session && isStaffRole(session.user.role)) {
			const { id, email, name, role } = session.user;
			event.locals.user = { id, email, name, role };
		}
	}

	if (isAdminPath) {
		const decision = guardAdminPath(pathname, event.locals.user?.role ?? null);
		if (decision.kind === 'login-redirect') redirect(303, '/admin/login');
		if (decision.kind === 'forbidden') error(403, 'Forbidden');
	}

	return resolve(event);
};

export const handle: Handle = sequence(
	handleSecurityHeaders,
	handleParaglide,
	handleSettings,
	handleAdminGuard
);

/**
 * Every unexpected server error is logged as one structured JSON line and
 * surfaced to the client only as a generic message plus an errorId that can
 * be grepped in the logs. Expected errors (error(404), redirects) never
 * reach this hook.
 */
export const handleError: HandleServerError = ({ error: err, event, status, message }) => {
	const errorId = crypto.randomUUID();
	console.error(
		formatServerError({
			error: err,
			errorId,
			status,
			method: event.request.method,
			path: event.url.pathname,
			message
		})
	);
	return { message, errorId };
};
