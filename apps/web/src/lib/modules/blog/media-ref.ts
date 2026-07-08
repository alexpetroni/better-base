import { eq, like, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { media } from '../media/schema.ts';
import { articles } from './schema.ts';

/**
 * Reference check handed to the media module so the library refuses to delete
 * images still used by articles — either as a cover (FK) or referenced from a
 * markdown body via `![alt](media:<id-or-key>)`.
 */
export const articlesMediaReferenceCheck = {
	name: 'articles',
	async isReferenced(db: Db, mediaId: string): Promise<boolean> {
		const [row] = await db.select({ key: media.key }).from(media).where(eq(media.id, mediaId));
		const bodyRefs = [like(articles.bodyMd, `%(media:${mediaId})%`)];
		if (row?.key) bodyRefs.push(like(articles.bodyMd, `%(media:${row.key})%`));
		const [hit] = await db
			.select({ one: sql`1` })
			.from(articles)
			.where(or(eq(articles.coverMediaId, mediaId), ...bodyRefs))
			.limit(1);
		return hit !== undefined;
	}
};
