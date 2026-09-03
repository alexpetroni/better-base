import { beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure, isRedirect } from '@sveltejs/kit';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { createAuth, type Auth } from '../../../lib/modules/auth/auth.ts';
import { loginAttempts, sessions, users } from '../../../lib/modules/auth/schema.ts';
import { upsertStaffUser } from '../../../lib/modules/auth/staff.ts';

/**
 * Login hardening (audit 2026-09-03, "Auth, GDPR & frontend"): the per-
 * IP+email lockout alone lets an attacker rotate IPs indefinitely against
 * one account. A SECOND counter keyed by email alone must bound the account
 * regardless of source; and a staff session must live ~12 hours, not the
 * better-auth default of 7 rolling days — these are accounts that can export
 * every subscriber and change the invoice IBAN.
 *
 * Runs the REAL /admin/login form action against the test database; only
 * getAuth is redirected to a framework-free instance (no sveltekitCookies —
 * there is no SvelteKit request store in vitest).
 */

const holder = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));

vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/db/index.ts')>();
	return { ...actual, getDb: () => holder.db };
});

vi.mock('$lib/modules/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/modules/auth/index.ts')>();
	return { ...actual, getAuth: () => holder.auth };
});

let db: Db;
let auth: Auth;

const EMAIL = 'lockout-target@example.com';
const PASSWORD = 'correct-horse-battery-staple';

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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	holder.db = db;
	auth = createAuth({ db, secret: 'test-secret-for-login-hardening' });
	holder.auth = auth;
	await upsertStaffUser(auth, { email: EMAIL, password: PASSWORD, role: 'admin' });
});

async function postLogin(input: { email: string; password: string; ip: string }) {
	const mod = await import('./+page.server.ts');
	const form = new FormData();
	form.set('email', input.email);
	form.set('password', input.password);
	const event = {
		request: new Request('http://localhost/admin/login', { method: 'POST', body: form }),
		getClientAddress: () => input.ip,
		locals: { user: null },
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		}
	};
	try {
		const result = await mod.actions.default(
			event as unknown as Parameters<(typeof mod)['actions']['default']>[0]
		);
		return { result, thrown: null as unknown };
	} catch (e) {
		return { result: null, thrown: e };
	}
}

function failureStatus(outcome: Awaited<ReturnType<typeof postLogin>>): number {
	if (!isActionFailure(outcome.result)) {
		throw new Error(`expected an ActionFailure, got: ${JSON.stringify(outcome)}`);
	}
	return outcome.result.status;
}

describe('email-keyed lockout (second counter, IP rotation bounded)', () => {
	it('caps 25 parallel wrong-password attempts from 25 DISTINCT IPs at 20 per email', async () => {
		const outcomes = await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				postLogin({ email: EMAIL, password: 'wrong-password-x', ip: `198.51.100.${i + 1}` })
			)
		);
		const statuses = outcomes.map(failureStatus);
		// The per-IP counter admits every request (each IP is fresh); only the
		// email-keyed counter can stop the rotation: 20 admitted (bad password
		// → 400), the rest locked out (429).
		expect(statuses.filter((s) => s === 400)).toHaveLength(20);
		expect(statuses.filter((s) => s === 429)).toHaveLength(5);
	}, 30_000);

	it('clears BOTH counters on a successful login', async () => {
		const email = 'lockout-clear@example.com';
		await upsertStaffUser(auth, { email, password: PASSWORD, role: 'editor' });
		const failed = await postLogin({ email, password: 'wrong-password-x', ip: '198.51.100.99' });
		expect(failureStatus(failed)).toBe(400);
		expect(await countersFor(email)).not.toHaveLength(0);

		const ok = await postLogin({ email, password: PASSWORD, ip: '198.51.100.99' });
		expect(isRedirect(ok.thrown)).toBe(true);
		expect(await countersFor(email)).toHaveLength(0);
	});
});

async function countersFor(email: string) {
	const rows = await db.select().from(loginAttempts);
	return rows.filter((r) => r.key.includes(email));
}

describe('staff session lifetime', () => {
	it('is ~12 hours, not the 7-day default', async () => {
		const email = 'session-lifetime@example.com';
		await upsertStaffUser(auth, { email, password: PASSWORD, role: 'editor' });
		const ok = await postLogin({ email, password: PASSWORD, ip: '198.51.100.98' });
		expect(isRedirect(ok.thrown)).toBe(true);

		const [user] = await db.select().from(users).where(eq(users.email, email));
		const [session] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
		const lifetimeH = (session.expiresAt.getTime() - session.createdAt.getTime()) / 3_600_000;
		expect(lifetimeH).toBeGreaterThan(11);
		expect(lifetimeH).toBeLessThan(13);
	});
});
