import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from '../auth/schema.ts';

/**
 * Media library. Two kinds of rows:
 * - `image`: an original uploaded to S3-compatible storage (`key` is the
 *   object path); served exclusively through signed imgproxy URLs.
 * - `video-embed`: a provider + external id (YouTube/Bunny) — no file is
 *   stored or handled, so the file columns stay null.
 */
export const media = pgTable(
	'media',
	{
		id: text('id').primaryKey(),
		kind: text('kind', { enum: ['image', 'video-embed'] })
			.notNull()
			.default('image'),
		// Storage object path, e.g. `uploads/2026/07/sunset-3f9a2b1c.webp`. Null for video embeds.
		key: text('key').unique(),
		filename: text('filename'),
		mime: text('mime'),
		size: integer('size'),
		width: integer('width'),
		height: integer('height'),
		alt: text('alt').notNull().default(''),
		blurhash: text('blurhash'),
		videoProvider: text('video_provider', { enum: ['youtube', 'bunny'] }),
		videoExternalId: text('video_external_id'),
		createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('media_created_at_idx').on(table.createdAt),
		check(
			'media_kind_shape',
			sql`(${table.kind} = 'image' and ${table.key} is not null and ${table.filename} is not null and ${table.mime} is not null and ${table.size} is not null)
			or (${table.kind} = 'video-embed' and ${table.videoProvider} is not null and ${table.videoExternalId} is not null and ${table.key} is null)`
		)
	]
);

export type MediaRow = typeof media.$inferSelect;
export type MediaKind = MediaRow['kind'];
export type VideoProvider = NonNullable<MediaRow['videoProvider']>;
