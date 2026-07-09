import { eq, like, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { media } from '../media/schema.ts';
import { products } from './schema.ts';

/**
 * Reference check handed to the media module so the library refuses to delete
 * images still used by products — as a cover (FK), inside the gallery (jsonb
 * array of media ids), or referenced from the markdown description via
 * `![alt](media:<id-or-key>)`.
 */
export const productsMediaReferenceCheck = {
	name: 'products',
	async isReferenced(db: Db, mediaId: string): Promise<boolean> {
		const [row] = await db.select({ key: media.key }).from(media).where(eq(media.id, mediaId));
		const descriptionRefs = [like(products.descriptionMd, `%(media:${mediaId})%`)];
		if (row?.key) descriptionRefs.push(like(products.descriptionMd, `%(media:${row.key})%`));
		const [hit] = await db
			.select({ one: sql`1` })
			.from(products)
			.where(
				or(
					eq(products.coverMediaId, mediaId),
					sql`${products.gallery} @> ${JSON.stringify([mediaId])}::jsonb`,
					...descriptionRefs
				)
			)
			.limit(1);
		return hit !== undefined;
	}
};
