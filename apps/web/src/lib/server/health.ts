import { sql } from 'drizzle-orm';
import type { Db } from '$lib/db/client';
import type { Storage } from '$lib/modules/media/server';

/**
 * Dependency health for /api/health: database + object storage reachability.
 * Framework-free deps so tests can point checks at broken endpoints. Each
 * check is bounded by a timeout — a hung dependency must degrade the health
 * endpoint, not hang it.
 */

export const HEALTH_CHECK_TIMEOUT_MS = 5000;

export type CheckStatus = 'ok' | 'error';

export interface HealthReport {
	healthy: boolean;
	checks: { db: CheckStatus; storage: CheckStatus };
}

async function bounded(run: () => Promise<unknown>, timeoutMs: number): Promise<CheckStatus> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			run(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
			})
		]);
		return 'ok';
	} catch {
		return 'error';
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A `null` dependency means it could not even be constructed (missing env) —
 * that is an immediate 'error', reported as 503 by the route, never a 500
 * with a stack (audit resilience #9).
 */
export async function checkHealth(
	deps: { db: Db | null; storage: Pick<Storage, 'headBucket'> | null },
	timeoutMs = HEALTH_CHECK_TIMEOUT_MS
): Promise<HealthReport> {
	const [db, storage] = await Promise.all([
		deps.db ? bounded(() => deps.db!.execute(sql`select 1`), timeoutMs) : ('error' as const),
		deps.storage ? bounded(() => deps.storage!.headBucket(), timeoutMs) : ('error' as const)
	]);
	return { healthy: db === 'ok' && storage === 'ok', checks: { db, storage } };
}
