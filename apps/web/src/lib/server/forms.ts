import { error, fail, redirect } from '@sveltejs/kit';
import type { Result } from '../util/result.ts';

/**
 * Shared form-action plumbing for the admin routes: string field reads, the
 * service-failure → fail() mapping, list filter parsing, the repeated
 * create-entity-then-open-editor action, and the per-handler authorization
 * guards every admin action/endpoint calls FIRST.
 */

export type StaffLocalsUser = NonNullable<App.Locals['user']>;

/**
 * Defense in depth (audit 2026-09-03 P0 #1): every admin form action and
 * every +server.ts under /admin and /api/shipments calls one of these FIRST,
 * so a hook-guard regression can never open reads or writes. Anonymous → 401;
 * the narrowed return replaces every `locals.user!` assertion.
 */
export function requireStaff(locals: App.Locals): StaffLocalsUser {
	if (!locals.user) error(401);
	return locals.user;
}

/** `requireStaff` + admin role (editor → 403). */
export function requireAdmin(locals: App.Locals): StaffLocalsUser {
	const user = requireStaff(locals);
	if (user.role !== 'admin') error(403);
	return user;
}

/** `String(form.get(key) ?? '')` — the admin forms' universal field read. */
export function formStr(form: FormData, key: string): string {
	return String(form.get(key) ?? '');
}

/** All values of a repeated field (checkbox lists, galleries), as strings. */
export function formStrAll(form: FormData, key: string): string[] {
	return form.getAll(key).map(String);
}

/**
 * Map a failed service Result to the shared admin failure shape:
 * `not-found` → 404, anything else → 400, `detail` always echoed as a string.
 * `extra` is spread into the payload (e.g. the quiz editor's textarea echo).
 */
export function failResult<E extends string, X extends Record<string, unknown>>(
	result: { ok: false; error: E; detail?: string },
	extra?: X
) {
	return fail(result.error === 'not-found' ? 404 : 400, {
		error: result.error,
		detail: result.detail ?? '',
		...(extra as X)
	});
}

export interface ListFilter<S extends string> {
	/** Service argument: undefined = no status filter. */
	status: S | undefined;
	search: string;
	/** Echo for the page's filter UI. */
	filter: { status: S | 'all'; search: string };
}

/** Parse `?status=` (whitelisted against `statuses`) and `?q=` for admin lists. */
export function parseListFilter<S extends string>(url: URL, statuses: readonly S[]): ListFilter<S> {
	const statusParam = url.searchParams.get('status');
	const status = statuses.includes(statusParam as S) ? (statusParam as S) : undefined;
	const search = url.searchParams.get('q') ?? '';
	return { status, search, filter: { status: status ?? 'all', search } };
}

/**
 * The admin list pages' create action: check the caller, read one text
 * field, create the row, 303 to its editor. Service failures come back as
 * fail(400, { error }).
 */
export function createEntityAction<T extends { id: string }>(opts: {
	field: string;
	/** Who may create — enforced before the form is even read. */
	require: 'staff' | 'admin';
	create: (value: string, user: StaffLocalsUser) => Promise<Result<T>>;
	redirectTo: (created: T) => string;
	/** Post-create side effect (e.g. Stripe sync) that must not block the redirect on failure. */
	afterCreate?: (created: T) => Promise<unknown>;
}) {
	return async ({ request, locals }: { request: Request; locals: App.Locals }) => {
		const user = opts.require === 'admin' ? requireAdmin(locals) : requireStaff(locals);
		const form = await request.formData();
		const result = await opts.create(formStr(form, opts.field), user);
		if (!result.ok) return fail(400, { error: result.error });
		await opts.afterCreate?.(result.value);
		redirect(303, opts.redirectTo(result.value));
	};
}
