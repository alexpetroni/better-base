import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { users } from '../auth/schema.ts';
import { imgproxyConfigFromEnv, storageConfigFromEnv } from './env.ts';
import { buildImgUrl, imgproxyPath, type ImgproxyConfig } from './imgproxy.ts';
import { media } from './schema.ts';
import {
	confirmUpload,
	createVideoEmbed,
	deleteMedia,
	registerMediaReferenceCheck,
	requestUpload,
	updateMediaAlt,
	type MediaDeps
} from './service.ts';
import { createStorage } from './storage.ts';

// Integration test against the compose stack: Postgres (TEST_DATABASE_URL,
// reset + re-migrated fresh), MinIO and imgproxy (all free/local — see
// docker-compose.yml). Skipped nowhere: the stack is a hard prerequisite,
// like the database is for auth.spec.ts.
let db: Db;
let deps: MediaDeps;
let imgproxy: ImgproxyConfig;

const FIXTURE = path.resolve(import.meta.dirname, '../../../../tests/fixtures/test-image.png');
const USER_ID = 'media-spec-user';

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	const storageCfg = storageConfigFromEnv(process.env);
	if (!storageCfg.endpoint) {
		throw new Error(
			'S3_* env vars are not set — start `docker compose up -d` and see .env.example'
		);
	}
	imgproxy = imgproxyConfigFromEnv(process.env);
	if (!imgproxy.baseUrl) throw new Error('IMGPROXY_* env vars are not set — see .env.example');

	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle')
	});
	await db
		.insert(users)
		.values({ id: USER_ID, name: 'Media Spec', email: 'media-spec@example.com' });

	const storage = createStorage(storageCfg);
	await storage.ensureBucket();
	deps = { db, storage };
});

afterAll(async () => {
	await db?.$client.end();
});

async function uploadFixture(): Promise<{ key: string; size: number }> {
	const bytes = await readFile(FIXTURE);
	const ticket = await requestUpload(deps, {
		filename: 'Test Image.png',
		mime: 'image/png',
		size: bytes.byteLength
	});
	if (!ticket.ok) throw new Error(`presign failed: ${ticket.error}`);

	const put = await fetch(ticket.value.uploadUrl, {
		method: 'PUT',
		headers: { 'content-type': 'image/png' },
		body: bytes
	});
	expect(put.status).toBe(200);
	return { key: ticket.value.key, size: bytes.byteLength };
}

describe('upload flow (presign → PUT → confirm)', () => {
	it('records a row with the object metadata and server-read dimensions', async () => {
		const { key, size } = await uploadFixture();
		const result = await confirmUpload(deps, {
			key,
			filename: 'Test Image.png',
			createdBy: USER_ID
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			kind: 'image',
			key,
			filename: 'Test Image.png',
			mime: 'image/png',
			size,
			// The fixture is generated at 320×200 (see tests/fixtures).
			width: 320,
			height: 200,
			createdBy: USER_ID
		});
	});

	it('rejects disallowed mime and oversized declarations at presign', async () => {
		const bad = await requestUpload(deps, { filename: 'x.pdf', mime: 'application/pdf', size: 10 });
		expect(bad).toEqual({ ok: false, error: 'invalid-mime' });
		const big = await requestUpload(deps, {
			filename: 'x.png',
			mime: 'image/png',
			size: 16 * 1024 * 1024
		});
		expect(big).toEqual({ ok: false, error: 'invalid-size' });
	});

	it('storage refuses a PUT whose content-type differs from the presigned one', async () => {
		const ticket = await requestUpload(deps, {
			filename: 'sneaky.png',
			mime: 'image/png',
			size: 100
		});
		if (!ticket.ok) throw new Error('presign failed');
		const put = await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'text/html' },
			body: new Uint8Array(100)
		});
		expect(put.status).toBe(403);
	});

	it('confirm fails for a key that was never uploaded', async () => {
		const result = await confirmUpload(deps, {
			key: 'uploads/2026/07/nothing-here.png',
			filename: 'nothing.png',
			createdBy: USER_ID
		});
		expect(result).toMatchObject({ ok: false, error: 'not-found' });
	});
});

describe('imgproxy serving', () => {
	it('serves a signed URL as webp and refuses unsigned/tampered URLs', async () => {
		const { key } = await uploadFixture();
		await confirmUpload(deps, { key, filename: 't.png', createdBy: USER_ID });

		const signed = buildImgUrl(imgproxy, key, { w: 100, format: 'webp' });
		const ok = await fetch(signed);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('image/webp');

		const unsigned = `${imgproxy.baseUrl}/unsigned${imgproxyPath(imgproxy, key, { w: 100, format: 'webp' })}`;
		expect((await fetch(unsigned)).status).toBe(403);

		// Valid signature for w:100 pasted onto a w:200 path must fail too.
		const tampered = signed.replace('rs:fit:100:0', 'rs:fit:200:0');
		expect((await fetch(tampered)).status).toBe(403);
	});

	it('serves an uploaded SVG sanitized and as an attachment (audit M1)', async () => {
		const malicious = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">' +
				'<script>alert(document.cookie)</script><rect width="10" height="10"/></svg>',
			'utf8'
		);
		const ticket = await requestUpload(deps, {
			filename: 'evil.svg',
			mime: 'image/svg+xml',
			size: malicious.byteLength
		});
		if (!ticket.ok) throw new Error('presign failed');
		const put = await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/svg+xml' },
			body: malicious
		});
		expect(put.status).toBe(200);

		// Exactly the URL the app embeds for SVG rows (att:1, no processing).
		const served = await fetch(buildImgUrl(imgproxy, ticket.value.key, { attachment: true }));
		expect(served.status).toBe(200);
		expect(served.headers.get('content-disposition')).toContain('attachment');
		const body = await served.text();
		expect(body).not.toContain('<script');
		expect(body).not.toContain('onload');
		expect(body).toContain('<rect'); // still a usable image, not an empty husk
	});
});

describe('alt, delete and reference checks', () => {
	it('updates alt text', async () => {
		const { key } = await uploadFixture();
		const created = await confirmUpload(deps, { key, filename: 'a.png', createdBy: USER_ID });
		if (!created.ok) throw new Error('confirm failed');
		const updated = await updateMediaAlt(deps, created.value.id, 'Un somn liniștit');
		expect(updated.ok && updated.value.alt).toBe('Un somn liniștit');
	});

	it('refuses deletion while referenced, deletes row + object afterwards', async () => {
		const { key } = await uploadFixture();
		const created = await confirmUpload(deps, { key, filename: 'b.png', createdBy: USER_ID });
		if (!created.ok) throw new Error('confirm failed');
		const id = created.value.id;

		const unregister = registerMediaReferenceCheck({
			name: 'spec-articles',
			isReferenced: async (_db, mediaId) => mediaId === id
		});
		try {
			expect(await deleteMedia(deps, id)).toMatchObject({
				ok: false,
				error: 'referenced',
				detail: 'spec-articles'
			});
		} finally {
			unregister();
		}

		const deleted = await deleteMedia(deps, id);
		expect(deleted.ok).toBe(true);
		expect(await deps.db.select().from(media).where(eq(media.id, id))).toHaveLength(0);
		expect(await deps.storage.statObject(key)).toBeNull();
	});

	it('stores and deletes video embeds without touching storage', async () => {
		const row = await createVideoEmbed(deps, {
			provider: 'youtube',
			externalId: 'dQw4w9WgXcQ',
			createdBy: USER_ID
		});
		expect(row.kind).toBe('video-embed');
		expect(row.key).toBeNull();
		const deleted = await deleteMedia(deps, row.id);
		expect(deleted.ok).toBe(true);
	});
});
