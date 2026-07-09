import { error, redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { deLocalizeUrl, getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { getAuth, guardAdminPath, isStaffRole } from '$lib/modules/auth';
// Side effect: registers the blog's and shop's media reference checks before
// any request can delete media (they live in the server barrels' module init).
import '$lib/modules/blog/server';
import '$lib/modules/shop/server';

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
