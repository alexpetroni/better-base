import { eq, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { mediaRefPattern } from '../../util/media-refs.ts';
import { media } from '../media/schema.ts';
import { quizzes } from './schema.ts';

/**
 * Reference check handed to the media module so the library refuses to delete
 * images a quiz intro still embeds via `![alt](media:<id-or-key>)` (FIX-15 —
 * intros were unguarded).
 */
export const quizzesMediaReferenceCheck = {
	name: 'quizzes',
	async isReferenced(db: Db, mediaId: string): Promise<boolean> {
		const [row] = await db.select({ key: media.key }).from(media).where(eq(media.id, mediaId));
		const refs = [sql`${quizzes.introMd} ~ ${mediaRefPattern(mediaId)}`];
		if (row?.key) refs.push(sql`${quizzes.introMd} ~ ${mediaRefPattern(row.key)}`);
		const [hit] = await db
			.select({ one: sql`1` })
			.from(quizzes)
			.where(or(...refs))
			.limit(1);
		return hit !== undefined;
	}
};
