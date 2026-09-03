import { beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../lib/db/client.ts';
import { users } from '../lib/modules/auth/schema.ts';
import { createSettingsLoader } from '../lib/modules/settings/service.ts';

/**
 * Defense-in-depth authorization, table-driven over the ROUTE MANIFEST
 * (audit 2026-09-03 P0 #1, layer 2): every admin form action and every
 * `+server.ts` under /admin and /api/shipments must refuse anonymous (401)
 * and, where admin-only, editor (403) callers ON ITS OWN — before reading
 * the form, before touching the database — so a hook-guard regression can
 * never open writes again.
 *
 * The manifest below is deliberately exhaustive both ways: a glob hit
 * without a row, a row without a glob hit, or an exported action/method
 * missing from its row FAILS the suite. Adding an admin route or action
 * therefore forces the author to declare who may call it.
 */

const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/db/index.ts')>();
	const { createDb: create } = await import('../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

/** Who may call an action/method. 'open' rows are login-only and not invoked. */
type RequiredRole = 'staff' | 'admin' | 'open';

interface ManifestRow {
	/** Form actions exported by a +page.server.ts. */
	actions?: Record<string, RequiredRole>;
	/** HTTP methods exported by a +server.ts. */
	methods?: Record<string, RequiredRole>;
}

const MANIFEST: Record<string, ManifestRow> = {
	'./admin/(shell)/articles/+page.server.ts': { actions: { create: 'staff' } },
	'./admin/(shell)/articles/[id]/+page.server.ts': {
		actions: { save: 'staff', publish: 'staff', unpublish: 'staff', preview: 'staff' }
	},
	'./admin/(shell)/media/+page.server.ts': {
		actions: { updateAlt: 'staff', delete: 'staff' }
	},
	'./admin/(shell)/media/upload/+server.ts': { methods: { POST: 'staff' } },
	'./admin/(shell)/nurture/+page.server.ts': { actions: { toggle: 'admin' } },
	'./admin/(shell)/orders/+page.server.ts': {},
	'./admin/(shell)/orders/[id]/+page.server.ts': {
		actions: {
			transition: 'admin',
			issueInvoice: 'admin',
			stornoPartial: 'admin',
			generateAwb: 'admin',
			resendInvoice: 'admin'
		}
	},
	'./admin/(shell)/orders/export/+server.ts': { methods: { GET: 'admin' } },
	'./admin/(shell)/pages/+page.server.ts': { actions: { create: 'admin' } },
	'./admin/(shell)/pages/[id]/+page.server.ts': { actions: { save: 'admin' } },
	'./admin/(shell)/products/+page.server.ts': { actions: { create: 'admin' } },
	'./admin/(shell)/products/[id]/+page.server.ts': { actions: { save: 'admin' } },
	'./admin/(shell)/quizzes/+page.server.ts': { actions: { create: 'staff' } },
	'./admin/(shell)/quizzes/[id]/+page.server.ts': {
		actions: { save: 'staff', publish: 'staff', unpublish: 'staff' }
	},
	'./admin/(shell)/settings/+page.server.ts': { actions: { save: 'admin' } },
	'./admin/(shell)/subscribers/+page.server.ts': {},
	'./admin/(shell)/subscribers/export.csv/+server.ts': { methods: { GET: 'admin' } },
	// Login is the one /admin surface that MUST accept anonymous posts.
	'./admin/login/+page.server.ts': { actions: { default: 'open' } },
	'./admin/logout/+page.server.ts': { actions: { default: 'staff' } },
	'./api/shipments/[id]/label/+server.ts': { methods: { GET: 'admin' } }
};

const discovered = {
	...import.meta.glob('./admin/**/+page.server.ts'),
	...import.meta.glob('./admin/**/+server.ts'),
	...import.meta.glob('./api/shipments/**/+server.ts')
} as Record<string, () => Promise<unknown>>;

const ADMIN = {
	id: 'authz-admin',
	email: 'authz-admin@example.com',
	name: 'Authz Admin',
	role: 'admin' as const
};
const EDITOR = {
	id: 'authz-editor',
	email: 'authz-editor@example.com',
	name: 'Authz Editor',
	role: 'editor' as const
};

let db: Db;

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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
	await db.insert(users).values([
		{ id: ADMIN.id, name: ADMIN.name, email: ADMIN.email, role: ADMIN.role },
		{ id: EDITOR.id, name: EDITOR.name, email: EDITOR.email, role: EDITOR.role }
	]);
	appDbHolder.db = db;
});

function locals(user: typeof ADMIN | typeof EDITOR | null): App.Locals {
	return { user, settings: createSettingsLoader(() => db) };
}

/**
 * Invoke a route action/method the way SvelteKit would, minus the hook guard
 * — that bypass is the point. The event is minimal on purpose: a guarded
 * handler must throw 401/403 before it ever reads the form or the params.
 */
function routeEvent(user: typeof ADMIN | typeof EDITOR | null, method: string) {
	const url = new URL('http://localhost/authz-spec');
	return {
		url,
		request: new Request(url, { method, body: method === 'GET' ? undefined : new FormData() }),
		params: { id: 'authz-spec-missing', month: '2026-01' },
		locals: locals(user),
		getClientAddress: () => '203.0.113.99'
	};
}

type Invocable = (event: unknown) => Promise<unknown>;

interface RouteModule {
	actions?: Record<string, Invocable>;
	[method: string]: unknown;
}

async function expectHttpError(fn: () => Promise<unknown>, status: number, label: string) {
	try {
		await fn();
		expect.fail(`${label}: expected a thrown ${status}, but the handler ran`);
	} catch (e) {
		if (!isHttpError(e, status)) {
			throw new Error(`${label}: expected ${status}, got: ${String(e)}`, { cause: e });
		}
		expect(e.status).toBe(status);
	}
}

describe('admin route manifest', () => {
	it('covers exactly the discovered routes (no unlisted admin surface)', () => {
		expect(Object.keys(discovered).sort()).toEqual(Object.keys(MANIFEST).sort());
	});

	it('lists every exported action and method of every route', async () => {
		for (const [file, load] of Object.entries(discovered)) {
			const row = MANIFEST[file];
			if (!row) continue; // the completeness test above reports it
			const mod = (await load()) as RouteModule;
			const exportedActions = Object.keys(mod.actions ?? {}).sort();
			expect(exportedActions, `${file} actions`).toEqual(Object.keys(row.actions ?? {}).sort());
			const exportedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
				.filter((m) => typeof mod[m] === 'function')
				.sort();
			expect(exportedMethods, `${file} methods`).toEqual(Object.keys(row.methods ?? {}).sort());
		}
	});
});

describe('every admin action and endpoint refuses unauthorized callers on its own', () => {
	for (const [file, row] of Object.entries(MANIFEST)) {
		const handlers = [
			...Object.entries(row.actions ?? {}).map(([name, role]) => ({
				name: `action ${name}`,
				role,
				invoke: async (user: typeof ADMIN | typeof EDITOR | null) => {
					const mod = (await discovered[file]()) as RouteModule;
					return mod.actions![name](routeEvent(user, 'POST'));
				}
			})),
			...Object.entries(row.methods ?? {}).map(([method, role]) => ({
				name: `method ${method}`,
				role,
				invoke: async (user: typeof ADMIN | typeof EDITOR | null) => {
					const mod = (await discovered[file]()) as RouteModule;
					return (mod[method] as Invocable)(routeEvent(user, method));
				}
			}))
		];

		for (const handler of handlers) {
			if (handler.role === 'open') continue;

			it(`${file} ${handler.name}: anonymous → 401`, async () => {
				await expectHttpError(() => handler.invoke(null), 401, `${file} ${handler.name}`);
			});

			if (handler.role === 'admin') {
				it(`${file} ${handler.name}: editor → 403`, async () => {
					await expectHttpError(() => handler.invoke(EDITOR), 403, `${file} ${handler.name}`);
				});
			}
		}
	}
});
