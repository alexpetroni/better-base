import { env } from '$env/dynamic/private';
import { createDb, poolConfigFromEnv, type Db } from './client.ts';

export * as schema from './schema/index.ts';
export { createDb, poolConfigFromEnv, type Db } from './client.ts';

let instance: Db | undefined;

/** The app's database, connected via DATABASE_URL. Lazy so that build/analysis never connects. */
export function getDb(): Db {
	if (!instance) {
		if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
		instance = createDb(env.DATABASE_URL, poolConfigFromEnv(env));
	}
	return instance;
}
