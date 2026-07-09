import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { emailLog, type EmailStatus } from './schema.ts';
import { renderEmailTemplate, type TemplateData, type TemplateKey } from './templates.ts';

/**
 * The idempotent email wrapper. Framework-free: the db, the dry-run flag and
 * the transport are passed in, so routes, scripts and tests build senders the
 * same way. Tests NEVER get a real transport — they either run dry or inject
 * a fake, so no email can ever leave a test run.
 */

export interface EmailMessage {
	from: string;
	replyTo?: string;
	to: string;
	subject: string;
	html: string;
	text: string;
}

/** What actually delivers mail: the Resend adapter in prod, a fake in tests. */
export interface EmailTransport {
	send(message: EmailMessage): Promise<{ providerId: string }>;
}

export interface EmailSenderConfig {
	db: Db;
	/** When true, sends are recorded in email_log but the transport is never touched. */
	dryRun: boolean;
	from: string;
	replyTo?: string;
	transport?: EmailTransport;
}

export interface SendEmailInput<K extends TemplateKey = TemplateKey> {
	to: string;
	template: K;
	data: TemplateData[K];
	/** Same key → at most one delivery, ever (skip if already sent/recorded). */
	idempotencyKey: string;
}

export type SendEmailOutcome =
	| { status: 'sent' | 'dryrun' | 'skipped'; logId: string }
	| { status: 'error'; logId: string; error: string };

export interface EmailSender {
	send<K extends TemplateKey>(input: SendEmailInput<K>): Promise<SendEmailOutcome>;
}

/**
 * Idempotency decision for an already-logged key: only rows that failed may
 * be retried; delivered, dry-run and in-flight rows are final.
 */
export function shouldSkipResend(status: EmailStatus): boolean {
	return status === 'sent' || status === 'dryrun' || status === 'sending';
}

export function createEmailSender(cfg: EmailSenderConfig): EmailSender {
	async function markStatus(
		logId: string,
		patch: { status: EmailStatus; providerId?: string; error?: string }
	): Promise<void> {
		await cfg.db
			.update(emailLog)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(emailLog.id, logId));
	}

	return {
		async send(input) {
			const rendered = renderEmailTemplate(input.template, input.data);
			const claimStatus: EmailStatus = cfg.dryRun ? 'dryrun' : 'sending';

			// Claim the key by insert: the unique index collapses concurrent
			// retries of the same handler to a single claimant.
			const inserted = await cfg.db
				.insert(emailLog)
				.values({
					id: crypto.randomUUID(),
					idempotencyKey: input.idempotencyKey,
					toEmail: input.to,
					template: input.template,
					subject: rendered.subject,
					data: input.data as Record<string, unknown>,
					status: claimStatus
				})
				.onConflictDoNothing({ target: emailLog.idempotencyKey })
				.returning();

			let claimed = inserted[0];
			if (!claimed) {
				const [existing] = await cfg.db
					.select()
					.from(emailLog)
					.where(eq(emailLog.idempotencyKey, input.idempotencyKey));
				if (!existing || shouldSkipResend(existing.status)) {
					return { status: 'skipped', logId: existing?.id ?? '' };
				}
				// A previous attempt failed — re-claim it. The status guard keeps
				// concurrent retries from both winning.
				const [reclaimed] = await cfg.db
					.update(emailLog)
					.set({ status: claimStatus, error: null, updatedAt: new Date() })
					.where(and(eq(emailLog.id, existing.id), eq(emailLog.status, 'error')))
					.returning();
				if (!reclaimed) return { status: 'skipped', logId: existing.id };
				claimed = reclaimed;
			}

			if (cfg.dryRun) return { status: 'dryrun', logId: claimed.id };

			if (!cfg.transport) {
				const message = 'No email transport configured — set RESEND_API_KEY or EMAIL_DRYRUN=true';
				await markStatus(claimed.id, { status: 'error', error: message });
				return { status: 'error', logId: claimed.id, error: message };
			}

			try {
				const { providerId } = await cfg.transport.send({
					from: cfg.from,
					replyTo: cfg.replyTo,
					to: input.to,
					subject: rendered.subject,
					html: rendered.html,
					text: rendered.text
				});
				await markStatus(claimed.id, { status: 'sent', providerId });
				return { status: 'sent', logId: claimed.id };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await markStatus(claimed.id, { status: 'error', error: message });
				return { status: 'error', logId: claimed.id, error: message };
			}
		}
	};
}
