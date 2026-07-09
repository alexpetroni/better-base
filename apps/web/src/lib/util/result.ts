/**
 * The shared success/failure envelope every module's services return. Each
 * module keeps its own error union (e.g. `BlogError`) and aliases this:
 * `type BlogResult<T> = Result<T, BlogError>` — the shape is defined once.
 */
export type Result<T, E extends string = string> =
	{ ok: true; value: T } | { ok: false; error: E; detail?: string };
