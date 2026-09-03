import { and, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { pendingRefunds } from './schema.ts';

/**
 * Retention for `pending_refunds` (refund-before-order rows, audit P0 #3).
 * Node-safe and framework-free like the ledger's prune, so the retention
 * sweep script can import it without the SvelteKit runtime. Only MATCHED rows
 * are swept: an unmatched one is a refund whose order never arrived — the
 * operator's cue to look at the Stripe dashboard, not something to forget.
 */
export async function pruneMatchedPendingRefunds(db: Db, cutoff: Date): Promise<number> {
	const deleted = await db
		.delete(pendingRefunds)
		.where(and(isNotNull(pendingRefunds.matchedAt), lt(pendingRefunds.matchedAt, cutoff)))
		.returning({ paymentIntent: pendingRefunds.paymentIntent });
	return deleted.length;
}
