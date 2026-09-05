import {
	CopyObjectCommand,
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutBucketPolicyCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PENDING_PREFIX } from './validation.ts';

/**
 * Thin S3 wrapper. Framework-free (config passed in, no $env) so scripts and
 * tests can use it. Works unchanged against MinIO (dev) and Cloudflare R2
 * (prod) — only the endpoint/credentials differ, and path-style addressing is
 * supported by both.
 */

export interface StorageConfig {
	endpoint: string;
	accessKey: string;
	secretKey: string;
	bucket: string;
	region: string;
}

export const PRESIGN_EXPIRES_SECONDS = 600;

/** Response headers stored as object metadata (echoed by every S3 origin). */
export interface ObjectHeaders {
	cacheControl?: string;
	contentDisposition?: string;
}

export type Storage = ReturnType<typeof createStorage>;

export function createStorage(cfg: StorageConfig) {
	const client = new S3Client({
		endpoint: cfg.endpoint,
		region: cfg.region,
		credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
		forcePathStyle: true
	});
	const bucket = cfg.bucket;

	return {
		bucket,

		/** Create the bucket if it does not exist (idempotent bootstrap). */
		async ensureBucket(): Promise<'created' | 'exists'> {
			try {
				await client.send(new CreateBucketCommand({ Bucket: bucket }));
				return 'created';
			} catch (err) {
				const name = (err as { name?: string }).name;
				if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
					return 'exists';
				}
				throw err;
			}
		},

		/**
		 * Reachability + bucket-existence probe (health checks). Throws when the
		 * endpoint is down or the bucket is missing — a HEAD on an object cannot
		 * tell those apart from a missing key.
		 */
		async headBucket(): Promise<void> {
			await client.send(new HeadBucketCommand({ Bucket: bucket }));
		},

		/**
		 * Presigned PUT URL for a direct browser upload. Content type and length
		 * are part of the signature, so the client cannot upload a different
		 * kind or size of payload than what was validated.
		 */
		presignPut(key: string, mime: string, size: number): Promise<string> {
			return getSignedUrl(
				client,
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					ContentType: mime,
					ContentLength: size
				}),
				{
					expiresIn: PRESIGN_EXPIRES_SECONDS,
					// The presigner leaves headers unsigned by default; force these
					// into the signature so a mismatching PUT is rejected by storage.
					signableHeaders: new Set(['content-type', 'content-length'])
				}
			);
		},

		/**
		 * Direct server-side upload (finalize, seeds, scripts; browsers use
		 * presigned PUTs into the quarantine prefix). Response headers the origin
		 * will echo (`Cache-Control`, `Content-Disposition`) are object metadata,
		 * so they are set here, at write time.
		 */
		async putObject(
			key: string,
			body: Uint8Array | string,
			mime: string,
			headers: ObjectHeaders = {}
		): Promise<void> {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: body,
					ContentType: mime,
					CacheControl: headers.cacheControl,
					ContentDisposition: headers.contentDisposition
				})
			);
		},

		/**
		 * Server-side copy with `MetadataDirective: REPLACE` — the copy carries
		 * exactly the content type and headers given here, nothing from the
		 * source. This is how confirm turns a quarantined upload into the served
		 * object without pulling the bytes through the function (rasters are
		 * up to 15 MB).
		 */
		async copyObject(
			fromKey: string,
			toKey: string,
			mime: string,
			headers: ObjectHeaders = {}
		): Promise<void> {
			await client.send(
				new CopyObjectCommand({
					Bucket: bucket,
					Key: toKey,
					CopySource: `${bucket}/${fromKey}`,
					MetadataDirective: 'REPLACE',
					ContentType: mime,
					CacheControl: headers.cacheControl,
					ContentDisposition: headers.contentDisposition
				})
			);
		},

		/** Object metadata, or null when the key does not exist. */
		async statObject(key: string): Promise<{ size: number; mime: string | undefined } | null> {
			try {
				const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return { size: head.ContentLength ?? 0, mime: head.ContentType };
			} catch (err) {
				if ((err as { name?: string }).name === 'NotFound') return null;
				throw err;
			}
		},

		/** Full object body (originals are ≤ 15 MB — used once to read dimensions). */
		async getObjectBytes(key: string): Promise<Uint8Array> {
			const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
			if (!res.Body) throw new Error(`Object ${key} has no body`);
			return res.Body.transformToByteArray();
		},

		/**
		 * Make the bucket anonymously readable (dev bootstrap only).
		 *
		 * The `direct` and `cloudflare` providers serve originals from a public
		 * origin. In production that is R2's custom-domain binding, done once in
		 * the Cloudflare dashboard; against MinIO there is no such concept, so
		 * local setup applies the equivalent bucket policy instead. Idempotent.
		 *
		 * The quarantine prefix (`PENDING_PREFIX`, where presigned uploads land
		 * before confirm finalizes them) is explicitly denied: an unconfirmed —
		 * unsanitized, header-less — object must never be fetchable from the
		 * origin. On R2 the same rule is a WAF block on the media host
		 * (DEPLOYMENT.md §5).
		 */
		async allowPublicRead(): Promise<void> {
			await client.send(
				new PutBucketPolicyCommand({
					Bucket: bucket,
					Policy: JSON.stringify({
						Version: '2012-10-17',
						Statement: [
							{
								Effect: 'Allow',
								Principal: { AWS: ['*'] },
								Action: ['s3:GetObject'],
								Resource: [`arn:aws:s3:::${bucket}/*`]
							},
							{
								Effect: 'Deny',
								Principal: { AWS: ['*'] },
								Action: ['s3:GetObject'],
								Resource: [`arn:aws:s3:::${bucket}/${PENDING_PREFIX}*`]
							}
						]
					})
				})
			);
		},

		async deleteObject(key: string): Promise<void> {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		},

		/** Every key under `prefix`, sorted (paginated; tooling and probes only). */
		async listKeys(prefix: string): Promise<string[]> {
			const keys: string[] = [];
			let token: string | undefined;
			do {
				const page = await client.send(
					new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
				);
				for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
				token = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (token);
			return keys.sort();
		}
	};
}
