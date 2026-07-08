import { PILLARS_BY_SLUG } from '../config/pillars.ts';
import type { Db } from './client.ts';
import { pillars } from './schema/core.ts';

/**
 * Upsert the given pillar slugs (in order) from the canonical definitions.
 * Idempotent: re-running updates rows in place and never duplicates.
 */
export async function seedPillars(db: Db, pillarSlugs: string[]): Promise<number> {
	let count = 0;
	for (const [index, slug] of pillarSlugs.entries()) {
		const def = PILLARS_BY_SLUG.get(slug);
		if (!def) throw new Error(`Cannot seed unknown pillar slug "${slug}"`);
		await db
			.insert(pillars)
			.values({ slug: def.slug, name: def.name, description: def.description, sort: index })
			.onConflictDoUpdate({
				target: pillars.slug,
				set: { name: def.name, description: def.description, sort: index }
			});
		count++;
	}
	return count;
}
