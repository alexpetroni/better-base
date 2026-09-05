/**
 * Batched deletes for the retention sweep (FIX-14): a single
 * `DELETE … WHERE created_at < cutoff` over a large table can never finish
 * inside `statement_timeout`, and the failure repeats every day. Each pruner
 * instead deletes `DELETE … WHERE id IN (SELECT id … LIMIT batch)` in a loop
 * until a batch comes back short.
 */
export const PRUNE_BATCH_SIZE = 5000;

/** Run `deleteBatch(limit)` until it deletes fewer rows than the limit; returns the total. */
export async function deleteInBatches(
	deleteBatch: (limit: number) => Promise<number>,
	batchSize: number = PRUNE_BATCH_SIZE
): Promise<number> {
	let total = 0;
	for (;;) {
		const deleted = await deleteBatch(batchSize);
		total += deleted;
		if (deleted < batchSize) return total;
	}
}
