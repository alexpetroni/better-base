import { beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isRedirect } from '@sveltejs/kit';
import { createDb, type Db } from '../../lib/db/client.ts';
import { createAuth } from '../../lib/modules/auth/auth.ts';
import { adminAudit, users } from '../../lib/modules/auth/schema.ts';
import { upsertStaffUser } from '../../lib/modules/auth/staff.ts';
import { media } from '../../lib/modules/media/schema.ts';
import { nurtureSequences } from '../../lib/modules/nurture/schema.ts';
import { pages } from '../../lib/modules/pages/schema.ts';
import { createSettingsLoader } from '../../lib/modules/settings/service.ts';

/**
 * The staff action log (audit 2026-09-03, login hardening): logins, PII/zip
 * exports, media deletes, nurture toggles and legal-page saves must each
 * leave one admin_audit row — and the table must be append-only at the
 * DATABASE level, so a compromised admin session cannot cover its tracks.
 */

const holder = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));

vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/db/index.ts')>();
	return { ...actual, getDb: () => holder.db };
});

vi.mock('$lib/modules/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/modules/auth/index.ts')>();
	return { ...actual, getAuth: () => holder.auth };
});

let db: Db;

const ADMIN = {
	id: 'audit-admin',
	email: 'audit-admin@example.com',
	name: 'Audit Admin',
	role: 'admin' as const
};
const LOGIN_EMAIL = 'audit-login@example.com';
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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') });
	holder.db = db;
	const auth = createAuth({ db, secret: 'test-secret-for-admin-audit' });
	holder.auth = auth;
	await upsertStaffUser(auth, { email: LOGIN_EMAIL, password: PASSWORD, role: 'admin' });
	await db
		.insert(users)
		.values({ id: ADMIN.id, name: ADMIN.name, email: ADMIN.email, role: ADMIN.role });
});

function locals(): App.Locals {
	return { user: ADMIN, settings: createSettingsLoader(() => db) };
}

async function auditRows(action: string) {
	return db.select().from(adminAudit).where(eq(adminAudit.action, action));
}

describe('admin_audit is append-only at the database level', () => {
	it('rejects UPDATE and DELETE like the fiscal tables', async () => {
		await db.insert(adminAudit).values({ actor: 'x@example.com', action: 'login' });
		// Drizzle wraps the pg error — the trigger message sits on the cause.
		const messageChain = (e: unknown) => {
			const err = e as Error & { cause?: Error };
			return `${err.message} ${err.cause?.message ?? ''}`;
		};
		await expect(
			db
				.update(adminAudit)
				.set({ actor: 'tampered' })
				.where(eq(adminAudit.actor, 'x@example.com'))
				.then(
					() => 'update succeeded',
					(e) => Promise.reject(new Error(messageChain(e)))
				)
		).rejects.toThrow(/append-only/);
		await expect(
			db
				.delete(adminAudit)
				.where(eq(adminAudit.actor, 'x@example.com'))
				.then(
					() => 'delete succeeded',
					(e) => Promise.reject(new Error(messageChain(e)))
				)
		).rejects.toThrow(/append-only/);
	});
});

describe('audited staff surfaces write one admin_audit row each', () => {
	it('login success → "login" by the account email', async () => {
		const mod = await import('./login/+page.server.ts');
		const form = new FormData();
		form.set('email', LOGIN_EMAIL);
		form.set('password', PASSWORD);
		let thrown: unknown = null;
		try {
			await mod.actions.default({
				request: new Request('http://localhost/admin/login', { method: 'POST', body: form }),
				getClientAddress: () => '203.0.113.7',
				locals: { user: null },
				cookies: {
					get: () => undefined,
					getAll: () => [],
					set: () => {},
					delete: () => {},
					serialize: () => ''
				}
			} as unknown as Parameters<(typeof mod)['actions']['default']>[0]);
		} catch (e) {
			thrown = e;
		}
		expect(isRedirect(thrown)).toBe(true);

		const rows = await auditRows('login');
		expect(rows.filter((r) => r.actor === LOGIN_EMAIL)).toHaveLength(1);
	});

	it('subscriber CSV export → "subscribers-export"', async () => {
		const mod = await import('./(shell)/subscribers/export.csv/+server.ts');
		const response = await mod.GET({
			locals: locals()
		} as unknown as Parameters<(typeof mod)['GET']>[0]);
		expect(response.status).toBe(200);

		const rows = await auditRows('subscribers-export');
		expect(rows).toHaveLength(1);
		expect(rows[0].actor).toBe(ADMIN.email);
	});

	it('monthly orders/invoices zip export → "orders-export" with the month', async () => {
		const mod = await import('./(shell)/orders/export/+server.ts');
		const response = await mod.GET({
			url: new URL('http://localhost/admin/orders/export?month=2026-01'),
			locals: locals()
		} as unknown as Parameters<(typeof mod)['GET']>[0]);
		expect(response.status).toBe(200);

		const rows = await auditRows('orders-export');
		expect(rows).toHaveLength(1);
		expect(rows[0].target).toBe('2026-01');
	});

	it('media delete → "media-delete" with the media id', async () => {
		await db.insert(media).values({
			id: 'audit-media',
			kind: 'video-embed',
			videoProvider: 'youtube',
			videoExternalId: 'dQw4w9WgXcQ'
		});
		const mod = await import('./(shell)/media/+page.server.ts');
		const form = new FormData();
		form.set('id', 'audit-media');
		const result = await mod.actions.delete({
			request: new Request('http://localhost/admin/media?/delete', {
				method: 'POST',
				body: form
			}),
			locals: locals()
		} as unknown as Parameters<(typeof mod)['actions']['delete']>[0]);
		expect(result).toMatchObject({ deleted: 'audit-media' });

		const rows = await auditRows('media-delete');
		expect(rows).toHaveLength(1);
		expect(rows[0].target).toBe('audit-media');
	});

	it('nurture toggle → "nurture-toggle" with the sequence id', async () => {
		await db.insert(nurtureSequences).values({
			id: 'audit-seq',
			key: 'audit-seq-key',
			name: 'Audit Sequence',
			trigger: { kind: 'consent-confirmed' }
		});
		const mod = await import('./(shell)/nurture/+page.server.ts');
		const form = new FormData();
		form.set('id', 'audit-seq');
		form.set('active', 'false');
		const result = await mod.actions.toggle({
			request: new Request('http://localhost/admin/nurture?/toggle', {
				method: 'POST',
				body: form
			}),
			locals: locals()
		} as unknown as Parameters<(typeof mod)['actions']['toggle']>[0]);
		expect(result).toMatchObject({ toggled: true });

		const rows = await auditRows('nurture-toggle');
		expect(rows).toHaveLength(1);
		expect(rows[0].target).toBe('audit-seq');
	});

	it('legal page save → "legal-page-save" with the page id', async () => {
		await db.insert(pages).values({
			id: 'audit-page',
			slug: 'politica-de-confidentialitate',
			title: 'Politica de confidențialitate',
			bodyMd: 'Text.'
		});
		const mod = await import('./(shell)/pages/[id]/+page.server.ts');
		const form = new FormData();
		form.set('title', 'Politica de confidențialitate');
		form.set('bodyMd', 'Text actualizat.');
		const result = await mod.actions.save({
			request: new Request('http://localhost/admin/pages/audit-page?/save', {
				method: 'POST',
				body: form
			}),
			params: { id: 'audit-page' },
			locals: locals()
		} as unknown as Parameters<(typeof mod)['actions']['save']>[0]);
		expect(result).toMatchObject({ saved: true });

		const rows = await auditRows('legal-page-save');
		expect(rows).toHaveLength(1);
		expect(rows[0].target).toBe('audit-page');
	});
});
