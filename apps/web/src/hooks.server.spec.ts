import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError, isRedirect, type Handle } from '@sveltejs/kit';
import { createDb, type Db } from './lib/db/client.ts';

// `sequence()` reads SvelteKit's AsyncLocalStorage request store, so the
// harness must enter it the way the server runtime does. The helper is an
// internal-but-exported runtime API whose published types are not a module —
// the specifier is assembled at runtime so neither tsc nor vite tries to
// type-resolve it, and the shape is declared locally instead.
const kitInternalServerSpecifier = ['@sveltejs/kit', 'internal', 'server'].join('/');
const { with_request_store: withRequestStore } = (await import(
	/* @vite-ignore */ kitInternalServerSpecifier
)) as {
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
	/** Observe the event the hooks mutate (locals set by handle). */
	onEvent?: (event: { locals: App.Locals }) => void;
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
	input.onEvent?.(event);
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

/**
 * SvelteKit's built-in origin check refuses EVERY cross-site form POST, which
 * would 403 the RFC 8058 one-click unsubscribe POST mail clients send (form
 * content type, no Origin). The check is therefore re-implemented in the hook
 * with exactly one exemption. Everything else must behave as kit did.
 */
describe('handleCsrf (kit origin check + the one-click unsubscribe exemption)', () => {
	const form = { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' };

	it('refuses a cross-site form POST to an ordinary route with 403 before it resolves', async () => {
		const outcome = await runHandle({
			method: 'POST',
			rawPath: '/newsletter',
			routeId: '/(public)/newsletter',
			headers: { ...form, origin: 'https://evil.example' }
		});
		expect(outcome.resolved).toBe(false);
		expect(outcome.response?.status).toBe(403);
	});

	it('refuses a form POST without any Origin header (kit parity)', async () => {
		const outcome = await runHandle({
			method: 'POST',
			rawPath: '/newsletter',
			routeId: '/(public)/newsletter',
			headers: form
		});
		expect(outcome.resolved).toBe(false);
		expect(outcome.response?.status).toBe(403);
	});

	it('lets a same-origin form POST through', async () => {
		const outcome = await runHandle({
			method: 'POST',
			rawPath: '/newsletter',
			routeId: '/(public)/newsletter',
			headers: { ...form, origin: 'http://localhost' }
		});
		expect(outcome.resolved).toBe(true);
	});

	it('lets a non-form POST (JSON webhooks) through regardless of origin', async () => {
		const outcome = await runHandle({
			method: 'POST',
			rawPath: '/api/webhooks/resend',
			routeId: '/api/webhooks/resend',
			headers: { 'content-type': 'application/json' }
		});
		expect(outcome.resolved).toBe(true);
	});

	it('exempts ONLY the one-click unsubscribe POST (form body, no origin)', async () => {
		const oneClick = await runHandle({
			method: 'POST',
			rawPath: '/unsubscribe/some-token',
			routeId: '/(public)/unsubscribe/[token]',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(oneClick.resolved).toBe(true);
		// The same shape against the confirm route stays refused.
		const confirm = await runHandle({
			method: 'POST',
			rawPath: '/newsletter/confirm/some-token',
			routeId: '/(public)/newsletter/confirm/[token]',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(confirm.resolved).toBe(false);
		expect(confirm.response?.status).toBe(403);
	});
});

describe('handleSecurityHeaders (audit 2026-09-03: no security headers / CSP anywhere)', () => {
	it('sets the header set + runtime CSP half on public responses', async () => {
		const outcome = await runHandle({ rawPath: '/blog', routeId: '/(public)/blog' });
		expect(outcome.resolved).toBe(true);
		const headers = outcome.response!.headers;

		expect(headers.get('x-content-type-options')).toBe('nosniff');
		expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
		expect(headers.get('x-frame-options')).toBe('DENY');
		expect(headers.get('permissions-policy')).toContain('camera=()');
		// PUBLIC_SITE_URL is http:// in the test env — no HSTS here (the pure
		// unit spec covers the https branch).
		expect(headers.get('strict-transport-security')).toBeNull();
		// Public pages stay cacheable; only /admin is forced no-store.
		expect(headers.get('cache-control')).toBeNull();

		const csp = headers.get('content-security-policy') ?? '';
		expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toMatch(/img-src [^;]*'self'/);
		expect(csp).toMatch(/img-src [^;]*data:/);
		expect(csp).toContain(
			'frame-src https://www.youtube-nocookie.com https://iframe.mediadelivery.net'
		);
		// The bucket endpoint is an ADMIN-only connect target (direct uploads).
		const s3Origin = new URL(process.env.S3_ENDPOINT!).origin;
		expect(csp).not.toContain(`connect-src 'self' ${s3Origin}`);
	});

	it('marks /admin responses no-store and lets the upload page reach the bucket', async () => {
		const outcome = await runHandle({ rawPath: '/admin/login', routeId: '/admin/login' });
		expect(outcome.resolved).toBe(true);
		const headers = outcome.response!.headers;

		expect(headers.get('cache-control')).toBe('private, no-store');
		const csp = headers.get('content-security-policy') ?? '';
		const s3Origin = new URL(process.env.S3_ENDPOINT!).origin;
		expect(csp).toContain(s3Origin);
		expect(csp).toMatch(/connect-src [^;]*'self'/);
	});
});

/**
 * FIX-16 (audit "Ops & platform"): every response carries a request id that
 * the error log line also carries, so one grep matches a user's report to
 * the server-side record. On Vercel it is the platform's own `x-vercel-id`;
 * elsewhere a UUID minted per request.
 */
describe('request id round-trip (FIX-16)', () => {
	it('mints a UUID, echoes it as x-request-id and exposes it to the route via locals', async () => {
		let event: { locals: App.Locals } | undefined;
		const outcome = await runHandle({
			rawPath: '/blog',
			routeId: '/(public)/blog',
			onEvent: (e) => (event = e)
		});
		expect(outcome.resolved).toBe(true);
		const echoed = outcome.response!.headers.get('x-request-id');
		expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(event?.locals.requestId).toBe(echoed);
	});

	// FIX-17 (FIX-16 review, medium): this process is not a Vercel function
	// (no VERCEL env), so an x-vercel-id on the request is client-supplied and
	// must not become our correlation key. Adopting it is Vercel-only —
	// `resolveRequestId` is unit-tested for that branch.
	it('ignores a client-supplied x-vercel-id off Vercel (mints a UUID instead)', async () => {
		let event: { locals: App.Locals } | undefined;
		const outcome = await runHandle({
			rawPath: '/blog',
			routeId: '/(public)/blog',
			headers: { 'x-vercel-id': 'spoofed-by-client' },
			onEvent: (e) => (event = e)
		});
		expect(outcome.resolved).toBe(true);
		expect(outcome.response!.headers.get('x-request-id')).not.toBe('spoofed-by-client');
		expect(outcome.response!.headers.get('x-request-id')).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
		expect(event?.locals.requestId).toBe(outcome.response!.headers.get('x-request-id'));
	});
});
