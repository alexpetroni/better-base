// Server module barrel: the idempotent sender, the log schema and the
// env-bound singleton the app uses. Dry-run is the default — real delivery
// requires BOTH EMAIL_DRYRUN=false and a RESEND_API_KEY.
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import { positiveIntEnv } from '$lib/server/env';
import { getSite } from '$lib/server/site';
import { createResendTransport, RESEND_TIMEOUT_MS_DEFAULT } from './resend.ts';
import { createEmailSender, type EmailSender } from './service.ts';

export { createResendTransport, RESEND_TIMEOUT_MS_DEFAULT } from './resend.ts';
export { emailLog, type EmailLogRow, type EmailStatus } from './schema.ts';
export {
	createEmailSender,
	shouldSkipResend,
	type EmailMessage,
	type EmailSender,
	type EmailSenderConfig,
	type EmailTransport,
	type SendEmailInput,
	type SendEmailOutcome
} from './service.ts';

let senderInstance: EmailSender | undefined;

/** The app's email sender: dry-run unless EMAIL_DRYRUN=false, Resend otherwise. */
export function getEmailSender(): EmailSender {
	if (!senderInstance) {
		const dryRun = env.EMAIL_DRYRUN !== 'false';
		if (!dryRun && !env.RESEND_API_KEY) {
			throw new Error('EMAIL_DRYRUN=false requires RESEND_API_KEY to be set');
		}
		const site = getSite();
		senderInstance = createEmailSender({
			db: getDb(),
			dryRun,
			from: `${site.name} <${site.email.from}>`,
			replyTo: site.email.replyTo,
			transport: dryRun
				? undefined
				: createResendTransport(
						env.RESEND_API_KEY!,
						fetch,
						positiveIntEnv(env.RESEND_TIMEOUT_MS, RESEND_TIMEOUT_MS_DEFAULT)
					)
		});
	}
	return senderInstance;
}
