import type { Db } from '../../src/lib/db/client.ts';

/**
 * Test-only fault injection: wraps a Drizzle client (and every transaction it
 * opens) so that `insert`/`update`/`delete` calls against ONE chosen table
 * throw while armed. This simulates a transient statement failure (deadlock,
 * dropped connection, kill) at an exact point inside a multi-write sequence —
 * the audit Theme B regression tests use it to prove all-or-nothing commits.
 */

type WriteOp = 'insert' | 'update' | 'delete';

export interface DbFault {
	arm(): void;
	disarm(): void;
	/** How many times the armed fault fired. */
	readonly hits: number;
}

export function withDbFault(db: Db, op: WriteOp, table: unknown): { db: Db; fault: DbFault } {
	let armed = false;
	let hits = 0;

	function wrap<T extends object>(conn: T): T {
		return new Proxy(conn, {
			get(target, prop) {
				if (prop === op) {
					return (candidate: unknown, ...rest: unknown[]) => {
						if (armed && candidate === table) {
							hits += 1;
							throw new Error(`injected ${op} fault`);
						}
						const method = Reflect.get(target, prop, target) as (...args: unknown[]) => unknown;
						return method.call(target, candidate, ...rest);
					};
				}
				if (prop === 'transaction') {
					const original = Reflect.get(target, prop, target) as (
						cb: (tx: object) => Promise<unknown>,
						cfg?: unknown
					) => Promise<unknown>;
					return (cb: (tx: object) => Promise<unknown>, cfg?: unknown) =>
						original.call(target, (tx) => cb(wrap(tx)), cfg);
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function'
					? (value as (...args: unknown[]) => unknown).bind(target)
					: value;
			}
		});
	}

	return {
		db: wrap(db),
		fault: {
			arm: () => {
				armed = true;
			},
			disarm: () => {
				armed = false;
			},
			get hits() {
				return hits;
			}
		}
	};
}
