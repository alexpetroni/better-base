import { MIN_PASSWORD_LENGTH, type Auth } from './auth.ts';
import { isStaffRole, type StaffRole } from './guards.ts';
import { EMAIL_RE } from '../../util/email.ts';

export interface UpsertStaffUserInput {
	email: string;
	password: string;
	role: StaffRole;
	name?: string;
}

export interface UpsertStaffUserResult {
	status: 'created' | 'updated';
	userId: string;
	email: string;
	role: StaffRole;
}

/**
 * Create a staff user with a credential account, or — idempotent on email —
 * update the existing user's role and password. Signup is disabled in
 * better-auth, so this goes through its internal adapter (same hashing the
 * login endpoint verifies against).
 */
export async function upsertStaffUser(
	auth: Auth,
	input: UpsertStaffUserInput
): Promise<UpsertStaffUserResult> {
	const email = input.email.trim().toLowerCase();
	if (!EMAIL_RE.test(email)) {
		throw new Error(`Invalid email address: "${input.email}"`);
	}
	if (input.password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	if (!isStaffRole(input.role)) {
		throw new Error(`Invalid role "${input.role}" — expected admin or editor`);
	}

	const ctx = await auth.$context;
	const passwordHash = await ctx.password.hash(input.password);
	const existing = await ctx.internalAdapter.findUserByEmail(email);

	if (existing) {
		await ctx.internalAdapter.updateUser(existing.user.id, { role: input.role });
		// updatePassword stores the value as-is on the credential account — hash first.
		await ctx.internalAdapter.updatePassword(existing.user.id, passwordHash);
		return { status: 'updated', userId: existing.user.id, email, role: input.role };
	}

	const user = await ctx.internalAdapter.createUser({
		email,
		name: input.name ?? email.split('@')[0],
		emailVerified: true,
		role: input.role
	});
	await ctx.internalAdapter.linkAccount({
		userId: user.id,
		providerId: 'credential',
		accountId: user.id,
		password: passwordHash
	});
	return { status: 'created', userId: user.id, email, role: input.role };
}
