/**
 * Structured server logging: one JSON object per line on stderr, so any log
 * collector (docker logs, journald, Cloudflare, …) can parse fields without
 * regexes. Pure formatting is separated from emission for unit testing.
 */

export interface ServerErrorLog {
	ts: string;
	level: 'error';
	errorId: string;
	status: number;
	method: string;
	path: string;
	message: string;
	/** Correlates with the `x-request-id` response header (FIX-16). */
	requestId?: string;
	stack?: string;
}

/**
 * Route prefixes whose next path segment is a capability token — a bearer
 * secret, not an identifier. A 500 on one of these must not copy the token
 * into the logs (audit L2): logs travel further than the database does.
 * Register any NEW token-in-path route here.
 */
const TOKEN_PATH_PREFIXES = ['/newsletter/confirm/', '/unsubscribe/'];

export function redactLogPath(path: string): string {
	for (const prefix of TOKEN_PATH_PREFIXES) {
		if (path.startsWith(prefix)) return `${prefix}[redacted]`;
	}
	return path;
}

/**
 * Drizzle's `DrizzleQueryError` message is `Failed query: <sql>\nparams: <params>`
 * — the params are the row values (chat text, addresses, CUIs, emails,
 * password hashes) and the stack repeats the message. Logs travel further
 * than the database does (audit 2026-09-03 "Ops & platform"), so the block is
 * cut from the first `params:` line onwards; the SQL text keeps the line
 * useful. Applied to every error text — a wrapped or re-thrown query error
 * carries the same block.
 */
const PARAMS_BLOCK = /\nparams: [\s\S]*$/;

export function redactQueryParams(text: string): string {
	return text.replace(PARAMS_BLOCK, '');
}

export function formatServerError(input: {
	error: unknown;
	errorId: string;
	status: number;
	method: string;
	path: string;
	message: string;
	requestId?: string;
	now?: Date;
}): string {
	const entry: ServerErrorLog = {
		ts: (input.now ?? new Date()).toISOString(),
		level: 'error',
		errorId: input.errorId,
		status: input.status,
		method: input.method,
		path: redactLogPath(input.path),
		message: input.error instanceof Error ? redactQueryParams(input.error.message) : input.message
	};
	if (input.requestId) entry.requestId = input.requestId;
	if (input.error instanceof Error && input.error.stack) {
		entry.stack = redactQueryParams(input.error.stack);
	}
	return JSON.stringify(entry);
}
