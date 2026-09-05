// The retention sweep: one job, two callers. `pnpm chat:prune` runs it from
// cron on a VPS; `/api/cron/chat-prune` runs it on Vercel, where there is no
// machine to run scripts on. Keeping the orchestration here means the two can
// never drift apart.
//
// Framework-free and node-safe (no $env/$app imports), so the plain-node
// script can import it directly.
import type { Db } from '../db/client.ts';
import { loginAttempts } from '../modules/auth/schema.ts';
import { CHAT_RETENTION_DAYS, pruneChatSessions } from '../modules/chat/service.ts';
import { NURTURE_RETENTION_DAYS, pruneNurtureEnrollments } from '../modules/nurture/service.ts';
import { pruneMatchedPendingRefunds } from '../modules/shop/webhook-prune.ts';
import { PROCESSED_EVENTS_RETENTION_DAYS, pruneProcessedEvents } from './event-ledger/core.ts';
import { pruneStaleRateLimits } from './rate-limit/core.ts';
import { rateLimits } from './rate-limit/schema.ts';

export interface RetentionSweepResult {
	/** Chat sessions deleted (messages cascade). */
	sessions: number;
	/** Rate-limit counter rows deleted, per table. */
	chatRateLimitRows: number;
	publicEmailRateLimitRows: number;
	loginRateLimitRows: number;
	/** Webhook idempotency-ledger rows past the redelivery window. */
	processedEventRows: number;
	/** Refund-before-order rows already matched to their order, past the same window. */
	pendingRefundRows: number;
	/** Closed nurture enrollments (sends cascade) past their window. */
	nurtureEnrollmentRows: number;
	retentionDays: number;
	ledgerRetentionDays: number;
	nurtureRetentionDays: number;
	/**
	 * Pruners that threw (FIX-14): each runs in its own try/catch so one
	 * failure never blocks the others; its count above stays 0.
	 */
	failures: { step: RetentionStep; message: string }[];
}

export type RetentionStep =
	| 'sessions'
	| 'chatRateLimitRows'
	| 'publicEmailRateLimitRows'
	| 'loginRateLimitRows'
	| 'processedEventRows'
	| 'pendingRefundRows'
	| 'nurtureEnrollmentRows';

/** The pruners, injectable so a test can make one fail. */
export interface RetentionPruners {
	pruneChatSessions: typeof pruneChatSessions;
	pruneStaleRateLimits: typeof pruneStaleRateLimits;
	pruneProcessedEvents: typeof pruneProcessedEvents;
	pruneMatchedPendingRefunds: typeof pruneMatchedPendingRefunds;
	pruneNurtureEnrollments: typeof pruneNurtureEnrollments;
}

/**
 * Delete chat sessions older than the retention window and sweep expired
 * rate-limit counters. The limiter upserts one row per key (`ip:`, `session:`,
 * `newsletter:ip:`, …) and never deletes, so without this the counter tables
 * grow unbounded (audit resilience #6).
 *
 * The counters' windows are minutes-to-an-hour, so the same 30-day cutoff is
 * far past any row that still influences a decision.
 */
export async function runRetentionSweep(
	db: Db,
	now: Date = new Date(),
	overrides: Partial<RetentionPruners> = {}
): Promise<RetentionSweepResult> {
	const p: RetentionPruners = {
		pruneChatSessions,
		pruneStaleRateLimits,
		pruneProcessedEvents,
		pruneMatchedPendingRefunds,
		pruneNurtureEnrollments,
		...overrides
	};
	const cutoff = new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	// The event ledger only needs to outlive the provider's redelivery window
	// (see PROCESSED_EVENTS_RETENTION_DAYS) — a longer, separate cutoff.
	const ledgerCutoff = new Date(
		now.getTime() - PROCESSED_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000
	);
	const nurtureCutoff = new Date(now.getTime() - NURTURE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

	const failures: RetentionSweepResult['failures'] = [];
	// Each pruner in its own try/catch (FIX-14): a failure is logged and
	// reported, and the remaining pruners still run.
	async function step(name: RetentionStep, run: () => Promise<number>): Promise<number> {
		try {
			return await run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ step: name, message });
			console.error(`retention sweep — ${name} failed: ${message}`);
			return 0;
		}
	}

	let chatRateLimitRows = 0;
	const sessions = await step('sessions', async () => {
		const chat = await p.pruneChatSessions(db, now);
		chatRateLimitRows = chat.rateLimitRows;
		return chat.sessions;
	});
	return {
		sessions,
		chatRateLimitRows,
		publicEmailRateLimitRows: await step('publicEmailRateLimitRows', () =>
			p.pruneStaleRateLimits(db, rateLimits, cutoff)
		),
		loginRateLimitRows: await step('loginRateLimitRows', () =>
			p.pruneStaleRateLimits(db, loginAttempts, cutoff)
		),
		processedEventRows: await step('processedEventRows', () =>
			p.pruneProcessedEvents(db, ledgerCutoff)
		),
		// Same window as the ledger: a matched pending refund is only evidence
		// for the redelivery period; unmatched rows are never swept (they are
		// the operator's signal that money went back without an order).
		pendingRefundRows: await step('pendingRefundRows', () =>
			p.pruneMatchedPendingRefunds(db, ledgerCutoff)
		),
		nurtureEnrollmentRows: await step('nurtureEnrollmentRows', () =>
			p.pruneNurtureEnrollments(db, nurtureCutoff)
		),
		retentionDays: CHAT_RETENTION_DAYS,
		ledgerRetentionDays: PROCESSED_EVENTS_RETENTION_DAYS,
		nurtureRetentionDays: NURTURE_RETENTION_DAYS,
		failures
	};
}

/** One-line summary for CLI output and structured logs. */
export function formatRetentionSweep(r: RetentionSweepResult): string {
	return (
		`retention sweep — deleted ${r.sessions} session(s) older than ${r.retentionDays} days, ` +
		`${r.chatRateLimitRows} chat / ${r.publicEmailRateLimitRows} public-email / ` +
		`${r.loginRateLimitRows} login rate-limit row(s), ` +
		`${r.processedEventRows} processed-event row(s) older than ${r.ledgerRetentionDays} days, ` +
		`${r.pendingRefundRows} matched pending-refund row(s) past the same window, ` +
		`${r.nurtureEnrollmentRows} closed nurture enrollment(s) older than ${r.nurtureRetentionDays} days` +
		(r.failures.length
			? `; FAILED: ${r.failures.map((f) => `${f.step} (${f.message})`).join(', ')}`
			: '')
	);
}
