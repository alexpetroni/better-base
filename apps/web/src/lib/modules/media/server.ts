// Server module barrel: signing, storage, db schema and services. Importing
// this from client code fails the build ($env/dynamic/private) — by design.
import { env } from '$env/dynamic/private';
import { imageProviderFromEnv, storageConfigFromEnv } from './env.ts';
import {
	imageSources,
	type ImageProvider,
	type ImageSourceInput,
	type ImageSources,
	type ImgOptions
} from './image.ts';
import { createStorage, type Storage } from './storage.ts';

export { blurhashFromPng, blurhashPlaceholder } from './blurhash.ts';
export {
	buildCloudflareImageUrl,
	cloudflareOptions,
	cloudflareOriginUrl,
	createCloudflareProvider,
	type CloudflareImagesConfig
} from './cloudflare.ts';
export { createDirectProvider, type DirectImagesConfig } from './direct.ts';
export {
	cloudflareConfigFromEnv,
	directOriginFromEnv,
	IMAGE_PROVIDERS,
	imageProviderFromEnv,
	imageProviderNameFromEnv,
	imgproxyConfigFromEnv,
	isImageProviderName,
	storageConfigFromEnv
} from './env.ts';
// imageSources is the one URL builder other modules consume (blog render).
export {
	buildSrcset,
	imageSources,
	srcsetWidths,
	type ImageProvider,
	type ImageProviderName,
	type ImageSourceInput,
	type ImageSources
} from './image.ts';
export {
	buildImgUrl,
	createImgproxyProvider,
	imgproxyPath,
	signImgproxyPath,
	type ImgproxyConfig
} from './imgproxy.ts';
export { media } from './schema.ts';
export {
	backfillBlurhashes,
	computeBlurhash,
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
export { createStorage, type Storage, type StorageConfig } from './storage.ts';
export { looksLikeSvg, sanitizeSvg } from './svg.ts';
export {
	signUploadTicket,
	verifyUploadTicket,
	type UploadTicketVerification
} from './upload-ticket.ts';

/** Env-bound singletons for the running app (scripts/tests pass config explicitly). */

function requireEnv(names: string[]): void {
	const missing = names.filter((n) => !env[n]);
	if (missing.length) throw new Error(`Missing media env vars: ${missing.join(', ')}`);
}

let storageInstance: Storage | undefined;
let providerInstance: ImageProvider | undefined;

export function getStorage(): Storage {
	if (!storageInstance) {
		requireEnv(['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET']);
		storageInstance = createStorage(storageConfigFromEnv(env));
	}
	return storageInstance;
}

/**
 * The image provider `IMAGE_PROVIDER` selects (`cloudflare` in production,
 * `direct` locally). Every caller goes through this rather than assuming a
 * transformer exists — `provider.transforms` says whether one does.
 */
export function getImageProvider(): ImageProvider {
	if (!providerInstance) providerInstance = imageProviderFromEnv(env);
	return providerInstance;
}

/** Image URL for a storage key, using the app's env config. */
export function imgUrl(key: string, opts: ImgOptions = {}): string {
	return getImageProvider().url(key, opts);
}

/** `ImageSources` for the <Img> component, using the app's env config. */
export function imgSources(
	source: ImageSourceInput,
	opts: Omit<ImgOptions, 'format' | 'dpr'> & { w: number }
): ImageSources {
	return imageSources(getImageProvider(), source, opts);
}
