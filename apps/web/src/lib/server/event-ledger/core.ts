import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { processedEvents } from './schema.ts';

/**
 * Exactly-once effects for redeliverable external events (webhooks, cron).
 * Framework-free like the rate-limit core, so scripts and tests can import it
 * without the SvelteKit runtime.
 */

/** The transaction client a `Db` hands its callback — what effects write through. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface LedgerEvent {
	provider: string;
	eventId: string;
	eventType: string;
}

export type RunOnceResult<T> =
	/** First delivery: the effect ran and committed together with the ledger row. */
	| { duplicate: false; outcome: string; value: T }
	/** Redelivery: the effect was skipped; `outcome` is what the first delivery recorded. */
	| { duplicate: true; outcome: string };

/**
 * Run `effect` at most once per (provider, eventId). The ledger row is
 * claimed by insert inside the same transaction the effect writes through:
 *
 * - a redelivery (the claim conflicts with a committed row) skips the effect
 *   and reports the recorded outcome;
 * - concurrent deliveries serialize on the claim — the loser sees a duplicate;
 * - a throwing effect rolls back the claim WITH its partial writes, so the
 *   provider's retry re-runs the whole unit instead of hitting a headless
 *   "already processed".
 *
 * The effect returns the outcome to record plus a value handed back to the
 * caller (for post-commit work like idempotent emails).
 */
export async function runOnce<T>(
	db: Db,
	event: LedgerEvent,
	effect: (tx: DbTx) => Promise<{ outcome: string; value: T }>
): Promise<RunOnceResult<T>> {
	return db.transaction(async (tx): Promise<RunOnceResult<T>> => {
		const claimed = await tx
			.insert(processedEvents)
			.values({
				provider: event.provider,
				eventId: event.eventId,
				eventType: event.eventType,
				// Placeholder until the effect commits; overwritten below. Only
				// observable from OUTSIDE the transaction if the effect hangs.
				outcome: 'in-flight'
			})
			.onConflictDoNothing({ target: [processedEvents.provider, processedEvents.eventId] })
			.returning({ eventId: processedEvents.eventId });
		if (claimed.length === 0) {
			const [existing] = await tx
				.select({ outcome: processedEvents.outcome })
				.from(processedEvents)
				.where(
					and(
						eq(processedEvents.provider, event.provider),
						eq(processedEvents.eventId, event.eventId)
					)
				);
			return { duplicate: true, outcome: existing?.outcome ?? 'unknown' };
		}

		const { outcome, value } = await effect(tx);
		await tx
			.update(processedEvents)
			.set({ outcome })
			.where(
				and(
					eq(processedEvents.provider, event.provider),
					eq(processedEvents.eventId, event.eventId)
				)
			);
		return { duplicate: false, outcome, value };
	});
}

/**
 * How long processed-event rows are kept. Stripe retries failed webhook
 * deliveries for up to 3 days and allows manual resends from the dashboard
 * for 30 days; 90 days is comfortably past both, and short enough that the
 * table stays a bounded working set rather than an archive (the durable
 * audit trail lives in `order_events`).
 */
export const PROCESSED_EVENTS_RETENTION_DAYS = 90;

/** Delete ledger rows received before `cutoff`. Returns the count removed. */
export async function pruneProcessedEvents(db: Db, cutoff: Date): Promise<number> {
	const deleted = await db
		.delete(processedEvents)
		.where(lt(processedEvents.receivedAt, cutoff))
		.returning({ eventId: processedEvents.eventId });
	return deleted.length;
}
