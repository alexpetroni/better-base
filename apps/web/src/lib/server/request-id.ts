import { redactLogPath } from './log.ts';

/**
 * Request correlation (FIX-16, audit "Ops & platform"): one id per request,
 * echoed to the client as `x-request-id`, carried by the error log line and
 * the error page, so a user's report and the server-side record match on a
 * single grep. Framework-free so the rules are unit-testable.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Vercel stamps every function invocation with `x-vercel-id` (visible in its
 * own request logs) — adopt it so our line and theirs share the key. A
 * CLIENT-supplied `x-request-id` is deliberately ignored: the correlation key
 * is ours to mint, never an attacker's to choose. Elsewhere: a UUID.
 */
export function resolveRequestId(
	headers: Headers,
	random: () => string = () => crypto.randomUUID()
): string {
	return headers.get('x-vercel-id') || random();
}

/**
 * Request logging is on by default for adapter-node (nothing else records
 * requests there) and off on Vercel (the platform logs every invocation with
 * the same `x-vercel-id`). `LOG_REQUESTS=true|false` overrides either.
 */
export function requestLogEnabled(env: Record<string, string | undefined>): boolean {
	if (env.LOG_REQUESTS === 'true') return true;
	if (env.LOG_REQUESTS === 'false') return false;
	return !env.VERCEL;
}

export interface RequestLog {
	ts: string;
	level: 'info';
	kind: 'request';
	method: string;
	path: string;
	status: number;
	durationMs: number;
	requestId: string;
}

/** One JSON line per request; the path goes through the same token redaction as errors. */
export function formatRequestLog(input: {
	method: string;
	path: string;
	status: number;
	durationMs: number;
	requestId: string;
	now?: Date;
}): string {
	const entry: RequestLog = {
		ts: (input.now ?? new Date()).toISOString(),
		level: 'info',
		kind: 'request',
		method: input.method,
		path: redactLogPath(input.path),
		status: input.status,
		durationMs: Math.round(input.durationMs),
		requestId: input.requestId
	};
	return JSON.stringify(entry);
}
