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

/** A file attached to a message; bytes stay in memory, only meta is logged. */
export interface EmailAttachment {
	filename: string;
	contentType: string;
	content: Uint8Array;
}

export interface EmailMessage {
	from: string;
	replyTo?: string;
	to: string;
	subject: string;
	html: string;
	text: string;
	attachments?: EmailAttachment[];
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
	attachments?: EmailAttachment[];
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
			// Lowercased once here so the log row AND the transport agree, and
			// GDPR erasure matches whatever casing the caller passed through.
			const to = input.to.trim().toLowerCase();
			const rendered = renderEmailTemplate(input.template, input.data);
			const claimStatus: EmailStatus = cfg.dryRun ? 'dryrun' : 'sending';

			// The log records attachment METADATA (name/type/size) so a dry run
			// or an audit shows what was carried — the bytes themselves are
			// re-renderable from their source and never enter the database.
			const attachmentMeta =
				input.attachments?.map(({ filename, contentType, content }) => ({
					filename,
					contentType,
					size: content.length
				})) ?? null;

			// Claim the key by insert: the unique index collapses concurrent
			// retries of the same handler to a single claimant.
			const inserted = await cfg.db
				.insert(emailLog)
				.values({
					id: crypto.randomUUID(),
					idempotencyKey: input.idempotencyKey,
					toEmail: to,
					template: input.template,
					subject: rendered.subject,
					data: input.data as Record<string, unknown>,
					attachments: attachmentMeta,
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
					to,
					subject: rendered.subject,
					html: rendered.html,
					text: rendered.text,
					attachments: input.attachments
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
