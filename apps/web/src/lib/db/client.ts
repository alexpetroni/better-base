import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Db = ReturnType<typeof createDb>;

/** Create a Drizzle client for an explicit connection string (scripts, tests). */
export function createDb(connectionString: string) {
	const pool = new pg.Pool({ connectionString });
	return drizzle(pool, { schema });
}
