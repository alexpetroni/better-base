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
	stack?: string;
}

export function formatServerError(input: {
	error: unknown;
	errorId: string;
	status: number;
	method: string;
	path: string;
	message: string;
	now?: Date;
}): string {
	const entry: ServerErrorLog = {
		ts: (input.now ?? new Date()).toISOString(),
		level: 'error',
		errorId: input.errorId,
		status: input.status,
		method: input.method,
		path: input.path,
		message: input.error instanceof Error ? input.error.message : input.message
	};
	if (input.error instanceof Error && input.error.stack) entry.stack = input.error.stack;
	return JSON.stringify(entry);
}
