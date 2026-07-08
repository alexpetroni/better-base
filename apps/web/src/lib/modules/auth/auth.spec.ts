import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { createAuth, type Auth } from './auth.ts';
import { sessions, users } from './schema.ts';
import { upsertStaffUser } from './staff.ts';

// Integration test against the compose Postgres (TEST_DATABASE_URL), reset and
// re-migrated fresh per run — same pattern as db/seed.spec.ts.
let db: Db;
let auth: Auth;

const EMAIL = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			'TEST_DATABASE_URL is not set — start the database with `docker compose up -d db` and configure .env'
		);
	}
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle')
	});
	auth = createAuth({ db, secret: 'test-secret-for-integration-tests' });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('upsertStaffUser', () => {
	it('creates a user with a credential account', async () => {
		const result = await upsertStaffUser(auth, {
			email: EMAIL,
			password: PASSWORD,
			role: 'editor'
		});
		expect(result.status).toBe('created');

		const rows = await db.select().from(users).where(eq(users.email, EMAIL));
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe('editor');
	});

	it('is idempotent on email: updates role and password, never duplicates', async () => {
		const result = await upsertStaffUser(auth, {
			email: EMAIL.toUpperCase(),
			password: 'a-brand-new-password',
			role: 'admin'
		});
		expect(result.status).toBe('updated');

		const rows = await db.select().from(users).where(eq(users.email, EMAIL));
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe('admin');
	});

	it('rejects passwords shorter than 12 characters', async () => {
		await expect(
			upsertStaffUser(auth, { email: 'x@example.com', password: 'short', role: 'editor' })
		).rejects.toThrow(/at least 12/);
	});

	it('rejects invalid emails and roles', async () => {
		await expect(
			upsertStaffUser(auth, { email: 'not-an-email', password: PASSWORD, role: 'editor' })
		).rejects.toThrow(/Invalid email/);
		await expect(
			upsertStaffUser(auth, {
				email: 'y@example.com',
				password: PASSWORD,
				// @ts-expect-error exercising the runtime validation
				role: 'superuser'
			})
		).rejects.toThrow(/Invalid role/);
	});
});

describe('sign-in', () => {
	it('creates a session on valid credentials', async () => {
		// The password was rotated by the idempotency test above.
		const result = await auth.api.signInEmail({
			body: { email: EMAIL, password: 'a-brand-new-password' }
		});
		expect(result.user.email).toBe(EMAIL);

		const rows = await db
			.select()
			.from(sessions)
			.where(eq(sessions.token, result.token ?? ''));
		expect(rows).toHaveLength(1);
	});

	it('creates no session on invalid credentials', async () => {
		const before = (await db.select().from(sessions)).length;
		await expect(
			auth.api.signInEmail({ body: { email: EMAIL, password: 'wrong-password-abc' } })
		).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
		expect((await db.select().from(sessions)).length).toBe(before);
	});

	it('rejects sign-up attempts (public signup is disabled)', async () => {
		await expect(
			auth.api.signUpEmail({
				body: { email: 'new@example.com', password: PASSWORD, name: 'New' }
			})
		).rejects.toMatchObject({ status: 'BAD_REQUEST' });
	});
});
