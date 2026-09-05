import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from './client.ts';
import { roleStatementTimeout, setRoleStatementTimeout } from './role-timeout.ts';

/**
 * FIX-16 (audit "Neon path edges"): behind PgBouncer a per-connection SET is
 * not a session guarantee, so the timeout is ALSO pinned on the role
 * (`ALTER ROLE … SET statement_timeout`), which every pooled connection
 * inherits. The script only ever alters the role it connects as
 * (CURRENT_USER), and re-running it is a no-op.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
const db = createDb(url);

afterAll(async () => {
	// Leave the shared compose role as it was found.
	await setRoleStatementTimeout(db, null);
	await db.$client.end();
});

describe('setRoleStatementTimeout', () => {
	it('pins statement_timeout on the connecting role, idempotently', async () => {
		const before = await roleStatementTimeout(db);
		expect(before.role).toBeTruthy();

		await setRoleStatementTimeout(db, '30s');
		expect(await roleStatementTimeout(db)).toEqual({ role: before.role, statementTimeout: '30s' });

		// Second run: same outcome, no error.
		await setRoleStatementTimeout(db, '30s');
		expect((await roleStatementTimeout(db)).statementTimeout).toBe('30s');

		// A new session sees it without any SET of its own.
		const fresh = createDb(url);
		try {
			const [row] = (await fresh.execute('show statement_timeout')).rows as Array<{
				statement_timeout: string;
			}>;
			expect(row.statement_timeout).toBe('30s');
		} finally {
			await fresh.$client.end();
		}
	});

	it('null resets the role setting', async () => {
		await setRoleStatementTimeout(db, null);
		expect((await roleStatementTimeout(db)).statementTimeout).toBeNull();
	});
});
