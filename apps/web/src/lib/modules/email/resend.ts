import type { EmailMessage, EmailTransport } from './service.ts';

/**
 * Resend delivery via its HTTP API. Only ever constructed by the server
 * barrel when EMAIL_DRYRUN is off and RESEND_API_KEY is set — tests and dev
 * default to dry-run and never reach this code.
 */
export function createResendTransport(
	apiKey: string,
	fetchFn: typeof fetch = fetch
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
				})
			});
			if (!response.ok) {
				throw new Error(`Resend responded ${response.status}: ${await response.text()}`);
			}
			const body = (await response.json()) as { id?: string };
			return { providerId: body.id ?? '' };
		}
	};
}
