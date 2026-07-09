import type { EmailMessage, EmailTransport } from './service.ts';

/** Default cap on a single Resend API call; override via RESEND_TIMEOUT_MS. */
export const RESEND_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Resend delivery via its HTTP API. Only ever constructed by the server
 * barrel when EMAIL_DRYRUN is off and RESEND_API_KEY is set — tests and dev
 * default to dry-run and never reach this code.
 *
 * Every call is bounded by `timeoutMs` (audit Theme C): a hung Resend socket
 * must reject — the sender records the failure as an `error` log row and the
 * caller moves on — never pin the request (the shop webhook awaits this
 * inline).
 */
export function createResendTransport(
	apiKey: string,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = RESEND_TIMEOUT_MS_DEFAULT
): EmailTransport {
	return {
		async send(message: EmailMessage) {
			const response = await fetchFn('https://api.resend.com/emails', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					from: message.from,
					to: [message.to],
					reply_to: message.replyTo,
					subject: message.subject,
					html: message.html,
					text: message.text
				}),
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!response.ok) {
				throw new Error(`Resend responded ${response.status}: ${await response.text()}`);
			}
			const body = (await response.json()) as { id?: string };
			return { providerId: body.id ?? '' };
		}
	};
}
