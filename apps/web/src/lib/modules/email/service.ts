import { and, eq, lte, or } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { EmailTransportError } from './resend.ts';
import { emailLog, type EmailLogRow, type EmailStatus } from './schema.ts';
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
	/** Extra headers the template asked for (List-Unsubscribe on marketing mail). */
	headers?: Record<string, string>;
	/**
	 * The email_log row's key, forwarded to the provider as its idempotency
	 * key (FIX-18): a retry of the same row after a transport timeout is the
	 * SAME request to Resend, never a second delivery.
	 */
	idempotencyKey: string;
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
	| {
			status: 'error';
			logId: string;
			error: string;
			/** False only for a classified permanent failure (EmailTransportError); unknown errors stay retryable. */
			retryable: boolean;
	  };

export interface EmailSender {
	/** Callers that reason about email_log rows need to know whether `dryrun` means delivered here. */
	readonly dryRun: boolean;
	send<K extends TemplateKey>(input: SendEmailInput<K>): Promise<SendEmailOutcome>;
}

/**
 * A `sending` claim older than this is presumed dead (a serverless kill
 * between the claim and the transport) and may be re-claimed. Comfortably
 * above any transport timeout, so a slow-but-alive delivery is never raced.
 */
export const EMAIL_SENDING_STALE_MS = 10 * 60 * 1000;

/**
 * Idempotency decision for an already-logged key (audit 2026-09-03 P1):
 * - `sent` is final; `error` may always be retried;
 * - `dryrun` is a RECORD, not a delivery — final only while the sender itself
 *   runs dry (the documented dry-run soak must not burn the key for launch);
 * - `sending` is in flight and final until the claim goes stale.
 */
export function shouldSkipResend(
	row: Pick<EmailLogRow, 'status' | 'updatedAt'>,
	ctx: { dryRun: boolean; now?: Date }
): boolean {
	switch (row.status) {
		case 'sent':
			return true;
		case 'error':
			return false;
		case 'dryrun':
			return ctx.dryRun;
		case 'sending':
			return (ctx.now ?? new Date()).getTime() - row.updatedAt.getTime() < EMAIL_SENDING_STALE_MS;
	}
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
		dryRun: cfg.dryRun,
		async send(input) {
			// Lowercased once here so the log row AND the transport agree, and
			// GDPR erasure matches whatever casing the caller passed through.
			const to = input.to.trim().toLowerCase();
			const now = new Date();
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
					headers: rendered.headers ?? null,
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
				if (!existing || shouldSkipResend(existing, { dryRun: cfg.dryRun, now })) {
					return { status: 'skipped', logId: existing?.id ?? '' };
				}
				// Re-claim it. The guard repeats shouldSkipResend's rule IN the
				// UPDATE, so of two concurrent retries only one wins: the loser
				// re-evaluates the WHERE after the winner's row lock releases and
				// finds a fresh `sending`/`dryrun` row.
				const staleCutoff = new Date(now.getTime() - EMAIL_SENDING_STALE_MS);
				const [reclaimed] = await cfg.db
					.update(emailLog)
					.set({ status: claimStatus, error: null, updatedAt: now })
					.where(
						and(
							eq(emailLog.id, existing.id),
							or(
								eq(emailLog.status, 'error'),
								and(eq(emailLog.status, 'sending'), lte(emailLog.updatedAt, staleCutoff)),
								cfg.dryRun ? undefined : eq(emailLog.status, 'dryrun')
							)
						)
					)
					.returning();
				if (!reclaimed) return { status: 'skipped', logId: existing.id };
				claimed = reclaimed;
			}

			if (cfg.dryRun) return { status: 'dryrun', logId: claimed.id };

			if (!cfg.transport) {
				const message = 'No email transport configured — set RESEND_API_KEY or EMAIL_DRYRUN=true';
				await markStatus(claimed.id, { status: 'error', error: message });
				return { status: 'error', logId: claimed.id, error: message, retryable: true };
			}

			try {
				const { providerId } = await cfg.transport.send({
					from: cfg.from,
					replyTo: cfg.replyTo,
					to,
					subject: rendered.subject,
					html: rendered.html,
					text: rendered.text,
					attachments: input.attachments,
					headers: rendered.headers,
					idempotencyKey: input.idempotencyKey
				});
				await markStatus(claimed.id, { status: 'sent', providerId });
				return { status: 'sent', logId: claimed.id };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const retryable = err instanceof EmailTransportError ? err.retryable : true;
				await markStatus(claimed.id, { status: 'error', error: message });
				return { status: 'error', logId: claimed.id, error: message, retryable };
			}
		}
	};
}
