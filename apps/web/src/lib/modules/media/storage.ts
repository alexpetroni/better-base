import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

		/** Direct server-side upload (seeds/scripts; browsers use presigned PUTs). */
		async putObject(key: string, body: Uint8Array | string, mime: string): Promise<void> {
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mime })
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

		async deleteObject(key: string): Promise<void> {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		}
	};
}
