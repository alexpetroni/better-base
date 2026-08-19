import type { ImageProvider } from './image.ts';

/**
 * The no-transformer provider: hand back the stored original.
 *
 * This is what local development and the whole test suite run on, so neither
 * needs a resizer container — `docker compose up` is Postgres + MinIO only.
 * `transforms: false` makes every caller degrade honestly instead of pretending:
 * srcsets come back empty (see `buildSrcset`) and blurhashes are skipped (see
 * `computeBlurhash`), rather than emitting N identical URLs or downloading a
 * full-size original to encode from.
 *
 * `launch:check` refuses this provider on a production target — serving
 * originals to real visitors would ship multi-megabyte photos to phones.
 */

export interface DirectImagesConfig {
	/**
	 * Public origin serving the stored originals. In dev this is MinIO's
	 * path-style bucket URL, e.g. `http://localhost:9000/better-base-media`.
	 */
	originBaseUrl: string;
}

export function createDirectProvider(cfg: DirectImagesConfig): ImageProvider {
	const base = cfg.originBaseUrl.replace(/\/$/, '');
	return {
		name: 'direct',
		transforms: false,
		url(key) {
			return `${base}/${key}`;
		}
	};
}
