import { redactLogPath } from './log.ts';

/**
 * Request correlation (FIX-16, audit "Ops & platform"): one id per request,
 * echoed to the client as `x-request-id`, carried by the error log line and
 * the error page, so a user's report and the server-side record match on a
 * single grep. Framework-free so the rules are unit-testable.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Vercel ids are short tokens like `fra1::iad1::abcde-1725000000000-0123456789ab`;
 * anything else in the header is not the platform's stamp.
 */
const VERCEL_ID_PATTERN = /^[A-Za-z0-9:-]{1,128}$/;

/**
 * Vercel stamps every function invocation with `x-vercel-id` (visible in its
 * own request logs) — adopt it there so our line and theirs share the key.
 * Only there (FIX-17): on adapter-node the header can only come from the
 * client, and — like a client-supplied `x-request-id`, which is ignored on
 * every target — the correlation key is ours to mint, never an attacker's
 * to choose. Elsewhere, or when the header is not a well-formed Vercel id:
 * a UUID.
 */
export function resolveRequestId(
	headers: Headers,
	random: () => string = () => crypto.randomUUID(),
	{ onVercel }: { onVercel: boolean }
): string {
	if (onVercel) {
		const stamped = headers.get('x-vercel-id');
		if (stamped && VERCEL_ID_PATTERN.test(stamped)) return stamped;
	}
	return random();
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
