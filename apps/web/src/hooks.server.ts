import { error, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { deLocalizeUrl, getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { getAuth, guardAdminPath, isStaffRole } from '$lib/modules/auth';
import { assertBootEnv } from '$lib/server/boot';
import { formatServerError } from '$lib/server/log';
// Side effect: registers the blog's and shop's media reference checks before
// any request can delete media (they live in the server barrels' module init).
import '$lib/modules/blog/server';
import '$lib/modules/shop/server';
// Side effect: selects the chat provider at boot — CHAT_PROVIDER=anthropic
// without an ANTHROPIC_API_KEY fails fast instead of at the first message.
import '$lib/modules/chat/server';

// Fail fast (audit resilience #10): refuse to boot on missing required env
// instead of 500ing on first use. PUBLIC_SITE_URL lives in the public env.
assertBootEnv({ ...env, PUBLIC_SITE_URL: publicEnv.PUBLIC_SITE_URL });

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
 * Server-side protection for everything under /admin (except /admin/login):
 * anonymous → redirect to login; editor on an admin-only section → 403.
 * Session lookup is skipped entirely for public routes.
 */
const handleAdminGuard: Handle = async ({ event, resolve }) => {
	event.locals.user = null;

	const pathname = deLocalizeUrl(event.url).pathname;
	if (pathname === '/admin' || pathname.startsWith('/admin/')) {
		const session = await getAuth().api.getSession({ headers: event.request.headers });
		if (session && isStaffRole(session.user.role)) {
			const { id, email, name, role } = session.user;
			event.locals.user = { id, email, name, role };
		}

		const decision = guardAdminPath(pathname, event.locals.user?.role ?? null);
		if (decision.kind === 'login-redirect') redirect(303, '/admin/login');
		if (decision.kind === 'forbidden') error(403, 'Forbidden');
	}

	return resolve(event);
};

export const handle: Handle = sequence(handleParaglide, handleAdminGuard);

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
