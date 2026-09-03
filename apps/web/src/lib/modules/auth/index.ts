// Module barrel: all cross-module imports go through this file.
// NOTE: server.ts (getAuth) uses $env/$app — scripts and vitest import the
// framework-free pieces via relative paths instead of this barrel.
export { createAuth, MIN_PASSWORD_LENGTH, type Auth, type CreateAuthOptions } from './auth.ts';
export { getAuth } from './server.ts';
export {
	canAccessSection,
	guardAdminPath,
	isStaffRole,
	routeIdPathname,
	type AdminGuardDecision,
	type StaffRole
} from './guards.ts';
export {
	clearAttempts,
	emailRateLimitKey,
	rateLimitKey,
	registerEmailLoginAttempt,
	registerLoginAttempt
} from './rate-limit.ts';
export { upsertStaffUser, type UpsertStaffUserInput, type UpsertStaffUserResult } from './staff.ts';
export { recordAdminAudit, type AdminAuditAction } from './audit.ts';
export {
	users,
	sessions,
	accounts,
	verifications,
	loginAttempts,
	adminAudit,
	type AdminAuditRow,
	type StaffUser
} from './schema.ts';
