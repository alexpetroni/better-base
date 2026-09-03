import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError, isRedirect, type Handle } from '@sveltejs/kit';
import * as kitInternalServer from '@sveltejs/kit/internal/server';
import { createDb, type Db } from './lib/db/client.ts';

// `sequence()` reads SvelteKit's AsyncLocalStorage request store, so the
// harness must enter it the way the server runtime does. The helper is an
// internal-but-exported API (used by adapters); typed here because the
// package's public types do not declare it.
const { with_request_store: withRequestStore } = kitInternalServer as unknown as {
	with_request_store: <T>(store: { event: unknown; state: unknown }, fn: () => T) => T;
};

/** Minimal OpenTelemetry span stand-in for the disabled-tracing path. */
const noopSpan = {
	end: () => {},
	setAttribute: () => {},
	setAttributes: () => {},
	recordException: () => {},
	setStatus: () => {},
	spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 })
};

/**
 * Hook-level regression for audit 2026-09-03 P0 #1: the /admin guard used to
 * key on `event.url.pathname`, which is NOT percent-decoded, while SvelteKit
 * decodes the path before matching routes. A raw request to `/%61dmin/…`
 * therefore reached the /admin route with the guard never running — an
 * anonymous subscriber export, and unauthenticated admin form actions
 * (actions run before any layout load).
 *
 * The harness calls the REAL exported `handle` with an event shaped the way
 * SvelteKit ships it: `url` carries the RAW (still-encoded) path while
 * `route.id` carries the route resolved from the DECODED path. The guard must
 * decide from `route.id`; deciding from the url pathname is the bug.
 */

const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./lib/db/index.ts')>();
	const { createDb: create } = await import('./lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
let handle: Handle;

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
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../drizzle') });
	({ handle } = await import('./hooks.server.ts'));
});

afterAll(async () => {
	await db?.$client.end();
});

interface HarnessOutcome {
	/** Did the guard let the request through to the route? */
	resolved: boolean;
	response: Response | null;
	/** A thrown redirect()/error(), when the guard refused. */
	thrown: unknown;
}

/**
 * Run `handle` against a raw request path. `routeId` is what SvelteKit's
 * router (which matches on the DECODED path) resolves the request to.
 */
async function runHandle(input: {
	method?: string;
	rawPath: string;
	routeId: string | null;
	headers?: Record<string, string>;
}): Promise<HarnessOutcome> {
	const url = new URL(`http://localhost${input.rawPath}`);
	const tracing = { enabled: false, root: noopSpan, current: noopSpan };
	const event = {
		url,
		request: new Request(url, { method: input.method ?? 'GET', headers: input.headers }),
		route: { id: input.routeId },
		locals: {} as App.Locals,
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		isSubRequest: false,
		isDataRequest: false,
		tracing
	};
	const state = {
		tracing: {
			record_span: <T>({ fn }: { fn: (span: typeof noopSpan) => T }) => fn(noopSpan)
		}
	};

	const outcome: HarnessOutcome = { resolved: false, response: null, thrown: null };
	try {
		outcome.response = await withRequestStore({ event, state }, () =>
			handle({
				// The harness event carries what the hooks read; the cast keeps the
				// full RequestEvent surface out of a spec that never resolves a page.
				event: event as unknown as Parameters<Handle>[0]['event'],
				resolve: () => {
					outcome.resolved = true;
					return Promise.resolve(new Response('route ran', { status: 200 }));
				}
			})
		);
	} catch (e) {
		outcome.thrown = e;
	}
	return outcome;
}

describe('handleAdminGuard vs percent-encoded /admin paths (audit P0 #1)', () => {
	it('refuses an anonymous GET /%61dmin/subscribers/export.csv (no CSV bytes)', async () => {
		const outcome = await runHandle({
			rawPath: '/%61dmin/subscribers/export.csv',
			routeId: '/admin/(shell)/subscribers/export.csv'
		});
		expect(outcome.resolved).toBe(false);
		expect(isRedirect(outcome.thrown)).toBe(true);
		expect(outcome.thrown).toMatchObject({ status: 303, location: '/admin/login' });
	});

	it('refuses an anonymous POST /%61dmin/pages/<id>?/save (action never runs)', async () => {
		const outcome = await runHandle({
			method: 'POST',
			rawPath: '/%61dmin/pages/some-page-id?/save',
			routeId: '/admin/(shell)/pages/[id]',
			headers: { accept: 'text/html' }
		});
		expect(outcome.resolved).toBe(false);
		expect(isRedirect(outcome.thrown)).toBe(true);
		expect(outcome.thrown).toMatchObject({ status: 303, location: '/admin/login' });
	});

	it('refuses an anonymous POST /%61dmin/media?/delete', async () => {
		const outcome = await runHandle({
			method: 'POST',
			rawPath: '/%61dmin/media?/delete',
			routeId: '/admin/(shell)/media',
			headers: { accept: 'text/html' }
		});
		expect(outcome.resolved).toBe(false);
		expect(isRedirect(outcome.thrown)).toBe(true);
	});
});

describe('handleAdminGuard on plain paths (unchanged behavior)', () => {
	it('still redirects an anonymous GET /admin/subscribers/export.csv to login', async () => {
		const outcome = await runHandle({
			rawPath: '/admin/subscribers/export.csv',
			routeId: '/admin/(shell)/subscribers/export.csv'
		});
		expect(outcome.resolved).toBe(false);
		expect(outcome.thrown).toMatchObject({ status: 303, location: '/admin/login' });
	});

	it('still lets anonymous visitors reach /admin/login', async () => {
		const outcome = await runHandle({ rawPath: '/admin/login', routeId: '/admin/login' });
		expect(outcome.resolved).toBe(true);
		expect(outcome.response?.status).toBe(200);
	});

	it('still resolves public routes without a guard decision', async () => {
		const outcome = await runHandle({ rawPath: '/blog', routeId: '/(public)/blog' });
		expect(outcome.resolved).toBe(true);
		expect(outcome.thrown).toBeNull();
	});

	it('lets an unmatched path fall through to the 404 (null route id)', async () => {
		const outcome = await runHandle({ rawPath: '/%61dmin-nope', routeId: null });
		expect(outcome.resolved).toBe(true);
		expect(isHttpError(outcome.thrown, 403)).toBe(false);
	});
});
