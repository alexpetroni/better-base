// Module barrel: all cross-module imports go through this file.
// NOTE: server.ts (getAuth) uses $env/$app — scripts and vitest import the
// framework-free pieces via relative paths instead of this barrel.
export { createAuth, MIN_PASSWORD_LENGTH, type Auth, type CreateAuthOptions } from './auth.ts';
export { getAuth } from './server.ts';
export {
	ADMIN_ONLY_SECTIONS,
	canAccessSection,
	guardAdminPath,
	isStaffRole,
	type AdminGuardDecision,
	type StaffRole
} from './guards.ts';
export {
	LOGIN_RATE_LIMIT,
	clearAttempts,
	rateLimitKey,
	registerLoginAttempt
} from './rate-limit.ts';
export { upsertStaffUser, type UpsertStaffUserInput, type UpsertStaffUserResult } from './staff.ts';
export {
	users,
	sessions,
	accounts,
	verifications,
	loginAttempts,
	type StaffUser
} from './schema.ts';
