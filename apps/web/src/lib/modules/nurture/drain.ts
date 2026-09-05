import { and, asc, eq, inArray, lt, lte, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { ConsentKey } from '../crm/consent.ts';
import { subscribers } from '../crm/schema.ts';
import { emailLog } from '../email/schema.ts';
import type { EmailSender } from '../email/service.ts';
import {
	NURTURE_MAX_ATTEMPTS,
	NURTURE_SEND_BATCH,
	NURTURE_SEND_PACE_MS,
	NURTURE_STALE_CLAIM_MINUTES,
	NURTURE_STALE_SEND_HOURS,
	retryDelayMs
} from './schedule.ts';
import { nurtureEnrollments, nurtureSends, nurtureSequences } from './schema.ts';
import { cancelEnrollment, closeEnrollmentIfDone, isMailable } from './service.ts';

/**
 * The queue drain behind /api/cron/nurture-send. Claim-then-send:
 *
 * 1. One transaction claims a bounded batch of due sends with
 *    `FOR UPDATE SKIP LOCKED` and flips them to `sending` — two concurrent
 *    cron invocations therefore claim DISJOINT sets; a double-send is
 *    structurally impossible. The `email_log` unique idempotency key
 *    (`nurture:<enrollmentId>:<stepIndex>`) is the independent second layer.
 * 2. Each claimed send re-checks the consent gate (defense in depth — a
 *    withdrawal between scheduling and sending cancels here), renders the
 *    step and sends through modules/email. Failures retry with exponential
 *    backoff and park as `failed` after NURTURE_MAX_ATTEMPTS.
 *
 * Crashed invocations leave `sending` rows; the claim re-takes them after
 * NURTURE_STALE_CLAIM_MINUTES, and the email idempotency key turns an
 * already-delivered retry into a no-op (`skipped` — recorded as sent only
 * when the email_log row itself reads as delivered).
 */

export interface NurtureDrainDeps {
	db: Db;
	email: EmailSender;
	siteName: string;
	/** Public origin for unsubscribe/CTA links, e.g. https://bettersleep.ro */
	baseUrl: string;
	/** Waits between two live sends (default: a real sleep; tests inject a spy). */
	pace?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface NurtureDrainResult {
	claimed: number;
	sent: number;
	retried: number;
	parked: number;
	cancelled: number;
	/** Due rows more than NURTURE_STALE_SEND_HOURS late, cancelled as `stale` instead of sent. */
	stale: number;
	/** Enrollments whose last open send resolved this run. */
	completed: number;
}

export async function drainNurtureSends(
	deps: NurtureDrainDeps,
	opts: { now?: Date; batchSize?: number } = {}
): Promise<NurtureDrainResult> {
	const now = opts.now ?? new Date();
	const batchSize = opts.batchSize ?? NURTURE_SEND_BATCH;
	const staleClaimCutoff = new Date(now.getTime() - NURTURE_STALE_CLAIM_MINUTES * 60 * 1000);
	const staleSendCutoff = new Date(now.getTime() - NURTURE_STALE_SEND_HOURS * 60 * 60 * 1000);
	const result: NurtureDrainResult = {
		claimed: 0,
		sent: 0,
		retried: 0,
		parked: 0,
		cancelled: 0,
		stale: 0,
		completed: 0
	};

	// Atomic claim. Only sends of ACTIVE sequences and enrollments are
	// eligible: deactivating a sequence in the admin pauses its queue rows in
	// place (reactivation resumes them) — the no-deploy stop switch.
	const eligible = and(
		eq(nurtureEnrollments.status, 'active'),
		eq(nurtureSequences.active, true),
		or(
			and(eq(nurtureSends.status, 'pending'), lte(nurtureSends.scheduledAt, now)),
			and(eq(nurtureSends.status, 'sending'), lte(nurtureSends.claimedAt, staleClaimCutoff))
		)
	);
	const { claimed, staleCount, staleEnrollmentIds } = await deps.db.transaction(async (tx) => {
		// Rows more than NURTURE_STALE_SEND_HOURS late are no longer wanted
		// (a resumed pause must not flood every missed step): cancelled here,
		// under the same eligibility, so a paused sequence's rows wait in
		// place and are judged at resume time (audit 2026-09-03 P2).
		const stale = await tx
			.select({ id: nurtureSends.id, enrollmentId: nurtureSends.enrollmentId })
			.from(nurtureSends)
			.innerJoin(nurtureEnrollments, eq(nurtureSends.enrollmentId, nurtureEnrollments.id))
			.innerJoin(nurtureSequences, eq(nurtureEnrollments.sequenceId, nurtureSequences.id))
			.where(and(eligible, lt(nurtureSends.scheduledAt, staleSendCutoff)))
			.for('update', { of: nurtureSends, skipLocked: true });
		if (stale.length > 0) {
			await tx
				.update(nurtureSends)
				.set({ status: 'cancelled', lastError: 'stale' })
				.where(
					inArray(
						nurtureSends.id,
						stale.map((row) => row.id)
					)
				);
		}
		const due = await tx
			.select({ id: nurtureSends.id })
			.from(nurtureSends)
			.innerJoin(nurtureEnrollments, eq(nurtureSends.enrollmentId, nurtureEnrollments.id))
			.innerJoin(nurtureSequences, eq(nurtureEnrollments.sequenceId, nurtureSequences.id))
			.where(eligible)
			.orderBy(
				asc(nurtureSends.scheduledAt),
				asc(nurtureSends.enrollmentId),
				asc(nurtureSends.stepIndex)
			)
			.limit(batchSize)
			.for('update', { of: nurtureSends, skipLocked: true });
		const rows =
			due.length === 0
				? []
				: await tx
						.update(nurtureSends)
						.set({ status: 'sending', claimedAt: now, attempts: sql`${nurtureSends.attempts} + 1` })
						.where(
							inArray(
								nurtureSends.id,
								due.map((row) => row.id)
							)
						)
						.returning();
		return {
			claimed: rows,
			staleCount: stale.length,
			staleEnrollmentIds: [...new Set(stale.map((row) => row.enrollmentId))]
		};
	});
	result.claimed = claimed.length;
	result.stale = staleCount;
	// A stale cancellation may have been the enrollment's last open row.
	for (const enrollmentId of staleEnrollmentIds) {
		if (await closeEnrollmentIfDone(deps.db, enrollmentId, now)) result.completed += 1;
	}

	// Within the batch, send grouped by enrollment in step order: a resumed
	// backlog must never deliver step 2 before step 1 (audit 2026-09-03 P2).
	claimed.sort((a, b) =>
		a.enrollmentId === b.enrollmentId
			? a.stepIndex - b.stepIndex
			: a.enrollmentId < b.enrollmentId
				? -1
				: 1
	);

	const pace = deps.pace ?? sleep;
	let liveSends = 0;
	for (const send of claimed) {
		const [row] = await deps.db
			.select({
				enrollment: nurtureEnrollments,
				sequence: nurtureSequences,
				subscriber: subscribers
			})
			.from(nurtureEnrollments)
			.innerJoin(nurtureSequences, eq(nurtureEnrollments.sequenceId, nurtureSequences.id))
			.innerJoin(subscribers, eq(nurtureEnrollments.subscriberId, subscribers.id))
			.where(eq(nurtureEnrollments.id, send.enrollmentId));
		if (!row) {
			// Enrollment (or subscriber) erased between claim and here — the send
			// row itself is gone too (cascade) or orphaned; nothing to record on.
			result.cancelled += 1;
			continue;
		}

		// Defense in depth: the gate that admitted the enrollment must still
		// hold at SEND time. A withdrawal cancels the whole enrollment here
		// even when `cancelSubscriberNurture` missed this row mid-claim.
		if (!isMailable(row.subscriber, row.sequence.consentKey as ConsentKey)) {
			await deps.db
				.update(nurtureSends)
				.set({ status: 'cancelled' })
				.where(eq(nurtureSends.id, send.id));
			await cancelEnrollment(deps.db, send.enrollmentId, now);
			result.cancelled += 1;
			continue;
		}

		const step = row.sequence.steps[send.stepIndex];
		if (!step) {
			await deps.db
				.update(nurtureSends)
				.set({ status: 'failed', lastError: 'step definition missing' })
				.where(eq(nurtureSends.id, send.id));
			result.parked += 1;
			continue;
		}

		const cta = step.cta
			? {
					label: step.cta.label,
					url: step.cta.url.startsWith('/') ? `${deps.baseUrl}${step.cta.url}` : step.cta.url
				}
			: undefined;
		// Pace live transport calls (Resend ~2 req/s); dry runs touch no API.
		if (!deps.email.dryRun && liveSends > 0) await pace(NURTURE_SEND_PACE_MS);
		if (!deps.email.dryRun) liveSends += 1;
		const outcome = await deps.email.send({
			to: row.subscriber.email,
			template: step.templateKey,
			data: {
				siteName: deps.siteName,
				subject: step.subject,
				paragraphs: step.paragraphs,
				cta,
				unsubscribeUrl: `${deps.baseUrl}/unsubscribe/${row.subscriber.unsubscribeToken}`
			},
			// One queue row == one delivery, ever: a stale-claim retry after a
			// successful send comes back `skipped`, never a second email.
			idempotencyKey: `nurture:${send.enrollmentId}:${send.stepIndex}`
		});

		// `skipped` means the email_log key was already claimed — by a previous
		// attempt of THIS row. That is a delivery only when the log row says
		// so: `sent`, or `dryrun` while the sender itself runs dry. An
		// in-flight (`sending`) or failed log row is not (audit 2026-09-03).
		let failure: string | null = null;
		let retryable = true;
		if (outcome.status === 'error') {
			failure = outcome.error;
			retryable = outcome.retryable;
		} else if (outcome.status === 'skipped') {
			const delivered = await logRowDelivered(deps, outcome.logId);
			if (!delivered) failure = `email log row ${outcome.logId || '?'} is not delivered`;
		}

		if (failure !== null) {
			// A classified permanent failure (bad key, rejected address) parks at
			// once — retrying it 5× over a day cannot help (audit 2026-09-03 P1).
			if (!retryable || send.attempts >= NURTURE_MAX_ATTEMPTS) {
				await deps.db
					.update(nurtureSends)
					.set({ status: 'failed', lastError: failure })
					.where(eq(nurtureSends.id, send.id));
				result.parked += 1;
			} else {
				await deps.db
					.update(nurtureSends)
					.set({
						status: 'pending',
						scheduledAt: new Date(now.getTime() + retryDelayMs(send.attempts)),
						lastError: failure
					})
					.where(eq(nurtureSends.id, send.id));
				result.retried += 1;
				continue;
			}
		} else {
			await deps.db
				.update(nurtureSends)
				.set({ status: 'sent', sentAt: now, lastError: null })
				.where(eq(nurtureSends.id, send.id));
			result.sent += 1;
		}

		// Terminal outcome: when no open sends remain, close the enrollment. A
		// parked (`failed`) send keeps it open — the operator's retry re-queues
		// the row and the enrollment must still be drainable (audit P2).
		if (await closeEnrollmentIfDone(deps.db, send.enrollmentId, now)) result.completed += 1;
	}

	return result;
}

/** Is the email_log row a delivery from this sender's point of view? */
async function logRowDelivered(deps: NurtureDrainDeps, logId: string): Promise<boolean> {
	if (!logId) return false;
	const [row] = await deps.db
		.select({ status: emailLog.status })
		.from(emailLog)
		.where(eq(emailLog.id, logId));
	if (!row) return false;
	return row.status === 'sent' || (row.status === 'dryrun' && deps.email.dryRun);
}
