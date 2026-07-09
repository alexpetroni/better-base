import { fail, redirect } from '@sveltejs/kit';
import type { Result } from '../util/result.ts';

/**
 * Shared form-action plumbing for the admin routes: string field reads, the
 * service-failure → fail() mapping, list filter parsing and the repeated
 * create-entity-then-open-editor action.
 */

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
 * The admin list pages' create action: read one text field, create the row,
 * 303 to its editor. Service failures come back as fail(400, { error }).
 */
export function createEntityAction<T extends { id: string }>(opts: {
	field: string;
	create: (value: string, locals: App.Locals) => Promise<Result<T>>;
	redirectTo: (created: T) => string;
	/** Post-create side effect (e.g. Stripe sync) that must not block the redirect on failure. */
	afterCreate?: (created: T) => Promise<unknown>;
}) {
	return async ({ request, locals }: { request: Request; locals: App.Locals }) => {
		const form = await request.formData();
		const result = await opts.create(formStr(form, opts.field), locals);
		if (!result.ok) return fail(400, { error: result.error });
		await opts.afterCreate?.(result.value);
		redirect(303, opts.redirectTo(result.value));
	};
}
