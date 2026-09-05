import type { EmailMessage, EmailTransport } from './service.ts';

/** Default cap on a single Resend API call; override via RESEND_TIMEOUT_MS. */
export const RESEND_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * A classified delivery failure (audit 2026-09-03 P1). `retryable` tells the
 * caller whether backing off and trying again can help: rate limits, outages
 * and network failures can; a 4xx other than 429 (bad key, rejected address,
 * malformed request) cannot, and the queue parks such a send immediately
 * with the provider's body instead of retrying it for a day.
 */
export class EmailTransportError extends Error {
	readonly retryable: boolean;
	readonly status: number | null;

	constructor(message: string, opts: { retryable: boolean; status?: number; cause?: unknown }) {
		super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
		this.name = 'EmailTransportError';
		this.retryable = opts.retryable;
		this.status = opts.status ?? null;
	}
}

/** 429 and every 5xx are transient; any other non-2xx is the request's fault. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * Resend delivery via its HTTP API. Only ever constructed by the server
 * barrel when EMAIL_DRYRUN is off and RESEND_API_KEY is set — tests and dev
 * default to dry-run and never reach this code.
 *
 * Every call is bounded by `timeoutMs` (audit Theme C): a hung Resend socket
 * must reject — the sender records the failure as an `error` log row and the
 * caller moves on — never pin the request (the shop webhook awaits this
 * inline). Failures are thrown as `EmailTransportError`, classified.
 *
 * Every call carries the message's email_log key as `Idempotency-Key`
 * (FIX-18, review 2026-09-05 #4): when the timeout fires AFTER Resend has
 * accepted the message, the retry of the same log row repeats the same key
 * and Resend answers with the original send instead of delivering twice
 * (its window is 24 h — longer than the queue's whole retry schedule).
 */
export function createResendTransport(
	apiKey: string,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = RESEND_TIMEOUT_MS_DEFAULT
): EmailTransport {
	return {
		async send(message: EmailMessage) {
			let response: Response;
			try {
				response = await fetchFn('https://api.resend.com/emails', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${apiKey}`,
						'content-type': 'application/json',
						'Idempotency-Key': message.idempotencyKey
					},
					body: JSON.stringify({
						from: message.from,
						to: [message.to],
						reply_to: message.replyTo,
						subject: message.subject,
						html: message.html,
						text: message.text,
						headers: message.headers,
						// Resend takes attachment bytes base64-encoded in the JSON body.
						attachments: message.attachments?.map((attachment) => ({
							filename: attachment.filename,
							content_type: attachment.contentType,
							content: Buffer.from(attachment.content).toString('base64')
						}))
					}),
					signal: AbortSignal.timeout(timeoutMs)
				});
			} catch (err) {
				// Network failure or the timeout above: nothing reached Resend
				// (or nothing came back) — worth retrying.
				const reason = err instanceof Error ? err.message : String(err);
				throw new EmailTransportError(`Resend request failed: ${reason}`, {
					retryable: true,
					cause: err
				});
			}
			if (!response.ok) {
				throw new EmailTransportError(
					`Resend responded ${response.status}: ${await response.text()}`,
					{ retryable: isRetryableStatus(response.status), status: response.status }
				);
			}
			const body = (await response.json()) as { id?: string };
			return { providerId: body.id ?? '' };
		}
	};
}
