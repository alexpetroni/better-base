export type StaffRole = 'admin' | 'editor';

/** /admin/<section> prefixes an editor may NOT access (admin role only). */
export const ADMIN_ONLY_SECTIONS = [
	'products',
	'orders',
	'subscribers',
	'nurture',
	'settings'
] as const;

export type AdminOnlySection = (typeof ADMIN_ONLY_SECTIONS)[number];

export type AdminGuardDecision =
	{ kind: 'allow' } | { kind: 'login-redirect' } | { kind: 'forbidden' };

export function isStaffRole(value: unknown): value is StaffRole {
	return value === 'admin' || value === 'editor';
}

/**
 * The pathname a resolved route id answers for, with layout groups stripped:
 * '/admin/(shell)/settings' → '/admin/settings'. Server guards must key on
 * THIS — SvelteKit matches routes on the percent-DECODED path, so a raw
 * request to '/%61dmin/…' reaches the /admin route while `url.pathname`
 * still reads '/%61dmin/…' (audit 2026-09-03 P0 #1). A null route id (no
 * match → 404) maps to '' and no guard applies.
 */
export function routeIdPathname(routeId: string | null): string {
	return (routeId ?? '').replace(/\/\([^/]+\)/g, '');
}

/** May this role open /admin/<section>? (Anonymous may not open anything.) */
export function canAccessSection(role: StaffRole, section: string): boolean {
	return role === 'admin' || !(ADMIN_ONLY_SECTIONS as readonly string[]).includes(section);
}

/**
 * Central server-side decision for a request path. Pure so it is
 * unit-testable; the server hook enforces the decision.
 */
export function guardAdminPath(pathname: string, role: StaffRole | null): AdminGuardDecision {
	const segments = pathname.split('/').filter(Boolean);
	if (segments[0] !== 'admin') return { kind: 'allow' };
	// The login page is the only /admin path open to anonymous visitors.
	if (segments[1] === 'login') return { kind: 'allow' };
	if (!role) return { kind: 'login-redirect' };
	if (segments.length > 1 && !canAccessSection(role, segments[1])) return { kind: 'forbidden' };
	return { kind: 'allow' };
}
