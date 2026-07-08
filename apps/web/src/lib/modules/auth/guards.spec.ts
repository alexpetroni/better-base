import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_SECTIONS, canAccessSection, guardAdminPath, isStaffRole } from './guards.ts';

describe('guardAdminPath', () => {
	it('allows non-admin paths for everyone', () => {
		expect(guardAdminPath('/', null)).toEqual({ kind: 'allow' });
		expect(guardAdminPath('/sanatate/somn', null)).toEqual({ kind: 'allow' });
		// Not under /admin, just a lookalike prefix.
		expect(guardAdminPath('/administrare', null)).toEqual({ kind: 'allow' });
	});

	it('allows the login page for anonymous visitors', () => {
		expect(guardAdminPath('/admin/login', null)).toEqual({ kind: 'allow' });
		expect(guardAdminPath('/admin/login/', null)).toEqual({ kind: 'allow' });
	});

	it('redirects anonymous visitors on every other /admin path', () => {
		expect(guardAdminPath('/admin', null)).toEqual({ kind: 'login-redirect' });
		expect(guardAdminPath('/admin/', null)).toEqual({ kind: 'login-redirect' });
		expect(guardAdminPath('/admin/articles', null)).toEqual({ kind: 'login-redirect' });
		expect(guardAdminPath('/admin/settings', null)).toEqual({ kind: 'login-redirect' });
		expect(guardAdminPath('/admin/logout', null)).toEqual({ kind: 'login-redirect' });
	});

	it('lets an admin through everywhere', () => {
		expect(guardAdminPath('/admin', 'admin')).toEqual({ kind: 'allow' });
		for (const section of ['articles', 'quizzes', 'media', ...ADMIN_ONLY_SECTIONS]) {
			expect(guardAdminPath(`/admin/${section}`, 'admin')).toEqual({ kind: 'allow' });
		}
	});

	it('blocks an editor on admin-only sections, including nested paths', () => {
		for (const section of ADMIN_ONLY_SECTIONS) {
			expect(guardAdminPath(`/admin/${section}`, 'editor')).toEqual({ kind: 'forbidden' });
			expect(guardAdminPath(`/admin/${section}/anything`, 'editor')).toEqual({
				kind: 'forbidden'
			});
		}
	});

	it('lets an editor into the dashboard and content sections', () => {
		expect(guardAdminPath('/admin', 'editor')).toEqual({ kind: 'allow' });
		for (const section of ['articles', 'quizzes', 'media', 'logout']) {
			expect(guardAdminPath(`/admin/${section}`, 'editor')).toEqual({ kind: 'allow' });
		}
	});
});

describe('canAccessSection', () => {
	it('mirrors the admin-only list for editors', () => {
		expect(canAccessSection('editor', 'articles')).toBe(true);
		expect(canAccessSection('editor', 'products')).toBe(false);
		expect(canAccessSection('admin', 'products')).toBe(true);
	});
});

describe('isStaffRole', () => {
	it('accepts only the two staff roles', () => {
		expect(isStaffRole('admin')).toBe(true);
		expect(isStaffRole('editor')).toBe(true);
		expect(isStaffRole('user')).toBe(false);
		expect(isStaffRole(null)).toBe(false);
	});
});
