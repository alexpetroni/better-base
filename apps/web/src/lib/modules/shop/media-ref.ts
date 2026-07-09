import { eq, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { products } from './schema.ts';

/**
 * Reference check handed to the media module so the library refuses to delete
 * images still used by products — as a cover (FK) or inside the gallery
 * (jsonb array of media ids).
 */
export const productsMediaReferenceCheck = {
	name: 'products',
	async isReferenced(db: Db, mediaId: string): Promise<boolean> {
		const [hit] = await db
			.select({ one: sql`1` })
			.from(products)
			.where(
				or(
					eq(products.coverMediaId, mediaId),
					sql`${products.gallery} @> ${JSON.stringify([mediaId])}::jsonb`
				)
			)
			.limit(1);
		return hit !== undefined;
	}
};
