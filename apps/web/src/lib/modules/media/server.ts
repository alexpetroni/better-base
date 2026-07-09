// Server module barrel: signing, storage, db schema and services. Importing
// this from client code fails the build ($env/dynamic/private) — by design.
import { env } from '$env/dynamic/private';
import { imgproxyConfigFromEnv, storageConfigFromEnv } from './env.ts';
import {
	buildImgUrl,
	imageSources,
	type ImageSources,
	type ImgOptions,
	type ImgproxyConfig
} from './imgproxy.ts';
import type { MediaRow } from './schema.ts';
import { createStorage, type Storage } from './storage.ts';

export { imgproxyConfigFromEnv, storageConfigFromEnv } from './env.ts';
export {
	buildImgUrl,
	buildSrcset,
	createImgUrl,
	imageSources,
	imgproxyPath,
	signImgproxyPath
} from './imgproxy.ts';
export { media } from './schema.ts';
export {
	confirmUpload,
	createVideoEmbed,
	deleteMedia,
	getMedia,
	listMedia,
	requestUpload,
	updateMediaAlt,
	type MediaDeleteDeps,
	type MediaDeps,
	type MediaError,
	type MediaReferenceCheck,
	type Result,
	type UploadTicket
} from './service.ts';
export {
	createStorage,
	PRESIGN_EXPIRES_SECONDS,
	type Storage,
	type StorageConfig
} from './storage.ts';
export {
	signUploadTicket,
	UPLOAD_TICKET_TTL_SECONDS,
	verifyUploadTicket,
	type UploadTicketVerification
} from './upload-ticket.ts';

/** Env-bound singletons for the running app (scripts/tests pass config explicitly). */

function requireEnv(names: string[]): void {
	const missing = names.filter((n) => !env[n]);
	if (missing.length) throw new Error(`Missing media env vars: ${missing.join(', ')}`);
}

let storageInstance: Storage | undefined;
let imgproxyInstance: ImgproxyConfig | undefined;

export function getStorage(): Storage {
	if (!storageInstance) {
		requireEnv(['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET']);
		storageInstance = createStorage(storageConfigFromEnv(env));
	}
	return storageInstance;
}

export function getImgproxyConfig(): ImgproxyConfig {
	if (!imgproxyInstance) {
		requireEnv(['IMGPROXY_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'S3_BUCKET']);
		imgproxyInstance = imgproxyConfigFromEnv(env);
	}
	return imgproxyInstance;
}

/** Signed imgproxy URL for a storage key, using the app's env config. */
export function imgUrl(key: string, opts: ImgOptions = {}): string {
	return buildImgUrl(getImgproxyConfig(), key, opts);
}

/** `ImageSources` for the <Img> component, using the app's env config. */
export function imgSources(
	source: Pick<MediaRow, 'key' | 'width' | 'height' | 'alt'> | string,
	opts: Omit<ImgOptions, 'format' | 'dpr'> & { w: number }
): ImageSources {
	return imageSources(getImgproxyConfig(), source, opts);
}
