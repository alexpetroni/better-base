import { redirect } from '@sveltejs/kit';
import { canAccessSection } from '$lib/modules/auth';
import type { LayoutServerLoad } from './$types';

// Sidebar entries; sections not in a role's reach are filtered server-side
// (the routes themselves are additionally protected by hooks.server.ts).
const ADMIN_NAV = [
	{ section: '', href: '/admin', message: 'dashboard' },
	{ section: 'articles', href: '/admin/articles', message: 'articles' },
	{ section: 'products', href: '/admin/products', message: 'products' },
	{ section: 'quizzes', href: '/admin/quizzes', message: 'quizzes' },
	{ section: 'media', href: '/admin/media', message: 'media' },
	{ section: 'subscribers', href: '/admin/subscribers', message: 'subscribers' },
	{ section: 'orders', href: '/admin/orders', message: 'orders' },
	{ section: 'settings', href: '/admin/settings', message: 'settings' }
] as const;

export const load: LayoutServerLoad = ({ locals }) => {
	// The hook guard guarantees a user here; keep a defensive fallback.
	if (!locals.user) redirect(303, '/admin/login');
	const user = locals.user;
	return {
		user,
		adminNav: ADMIN_NAV.filter((item) => canAccessSection(user.role, item.section))
	};
};
