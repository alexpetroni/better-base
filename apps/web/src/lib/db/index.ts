import { env } from '$env/dynamic/private';
import { createDb, dbDriverFromEnv, poolConfigFromEnv, type Db } from './client.ts';

export * as schema from './schema/index.ts';
export { createDb, dbDriverFromEnv, poolConfigFromEnv, type Db, type DbDriver } from './client.ts';

let instance: Db | undefined;

/**
 * The app's database, connected via DATABASE_URL with the driver named by
 * DB_DRIVER (`pg` by default, `neon` on serverless). Lazy so that
 * build/analysis never connects.
 */
export function getDb(): Db {
	if (!instance) {
		if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
		const driver = dbDriverFromEnv(env);
		instance = createDb(env.DATABASE_URL, poolConfigFromEnv(env, driver), driver);
	}
	return instance;
}
