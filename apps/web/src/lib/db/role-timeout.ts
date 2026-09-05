import { sql } from 'drizzle-orm';
import type { Db } from './client.ts';

/**
 * Role-level `statement_timeout` (FIX-16, audit "Neon path edges"). The
 * app's per-connection SET (client.ts) is not a session guarantee behind
 * Neon's PgBouncer; a setting pinned on the ROLE is inherited by every
 * connection that role opens, pooled or not. Only ever touches the role the
 * caller connects as — `CURRENT_USER` — so a script run with the app's
 * credentials cannot alter another role. Idempotent: re-running with the
 * same value is a no-op; `null` resets.
 */
export async function setRoleStatementTimeout(db: Db, timeout: string | null): Promise<void> {
	if (timeout === null) {
		await db.execute(sql`alter role current_user reset statement_timeout`);
		return;
	}
	if (!/^\d+(ms|s|min|h)?$/.test(timeout)) {
		throw new Error(`invalid statement_timeout "${timeout}" — expected e.g. 30s or 30000`);
	}
	// A role setting takes a literal; validated above, so interpolating the
	// raw value is safe.
	await db.execute(sql.raw(`alter role current_user set statement_timeout = '${timeout}'`));
}

/** The connecting role and its pinned statement_timeout (null when none). */
export async function roleStatementTimeout(
	db: Db
): Promise<{ role: string; statementTimeout: string | null }> {
	const result = await db.execute(sql`
		select current_user as role,
			(select s.setting from pg_db_role_setting rs
				cross join lateral unnest(rs.setconfig) as s(setting)
				where rs.setrole = (select oid from pg_roles where rolname = current_user)
					and rs.setdatabase = 0
					and s.setting like 'statement_timeout=%') as setting
	`);
	const row = result.rows[0] as { role: string; setting: string | null };
	return {
		role: row.role,
		statementTimeout: row.setting ? row.setting.slice('statement_timeout='.length) : null
	};
}
