// Universal module barrel: safe to import from components and client code.
// Everything that signs URLs or touches storage/db lives behind
// `$lib/modules/media/server` (the server barrel) instead.
export { default as Img } from './Img.svelte';
export type { ImageSources, ImgFit, ImgFormat, ImgOptions, ImgproxyConfig } from './imgproxy.ts';
export type { MediaKind, MediaRow, VideoProvider } from './schema.ts';
export {
	ALLOWED_IMAGE_MIMES,
	isAllowedImageMime,
	MAX_UPLOAD_BYTES,
	mediaKeyFor,
	validateUpload,
	type AllowedImageMime,
	type UploadValidation
} from './validation.ts';
