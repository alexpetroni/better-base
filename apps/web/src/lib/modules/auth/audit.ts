import type { Db } from '../../db/client.ts';
import { adminAudit } from './schema.ts';

/**
 * The staff action log's single write path. Framework-free (db passed in);
 * called AFTER the audited operation succeeds, inside the same request. The
 * union keeps action names from fragmenting per call site — extend it when a
 * new surface becomes auditable.
 */
export type AdminAuditAction =
	| 'login'
	| 'subscribers-export'
	| 'orders-export'
	| 'media-delete'
	| 'nurture-toggle'
	| 'legal-page-save';

export async function recordAdminAudit(
	db: Db,
	entry: { actor: string; action: AdminAuditAction; target?: string }
): Promise<void> {
	await db
		.insert(adminAudit)
		.values({ actor: entry.actor, action: entry.action, target: entry.target ?? '' });
}
