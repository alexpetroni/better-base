import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { users } from '../auth/schema.ts';
import { PNG } from 'pngjs';
import { imageProviderFromEnv, storageConfigFromEnv } from './env.ts';
import type { ImageProvider } from './image.ts';
import { media } from './schema.ts';
import {
	backfillBlurhashes,
	confirmUpload,
	createVideoEmbed,
	deleteMedia,
	listMedia,
	requestUpload,
	updateMediaAlt,
	type MediaDeps,
	type MediaReferenceCheck
} from './service.ts';
import { createStorage } from './storage.ts';
import { mediaKeyFor } from './validation.ts';

// Integration test against the compose stack: Postgres (TEST_DATABASE_URL,
// reset + re-migrated fresh) and MinIO — no image transformer, because the
// suite runs on the `direct` provider (see docker-compose.yml). Skipped
// nowhere: the stack is a hard prerequisite, like the database is for
// auth.spec.ts.
let db: Db;
let deps: MediaDeps;
/** The provider the app would use locally: originals straight off MinIO. */
let images: ImageProvider;

/**
 * A stand-in transformer, so confirm-time and backfill blurhashing keep their
 * coverage without a resizer container. It answers with a `data:` URL (node's
 * fetch reads those), and — crucially — it is NOT a rubber stamp: what it
 * returns is derived from the bytes the test actually uploaded, so a corrupt
 * upload still fails to produce a blurhash exactly as a real transformer would.
 * That a REAL transformer answers these URLs is proven by launch:check's live
 * probe against the deployed environment, which is the only place it can be.
 */
const uploadedBytes = new Map<string, Uint8Array>();

/**
 * The served key is minted at confirm (FIX-15: uploads land in quarantine
 * first), so the fake is keyed by the filename slug the served key embeds —
 * `uploads/<yyyy>/<mm>/<slug>-<8 hex>.<ext>` — rather than by the key itself.
 */
function servedSlug(filename: string): string {
	const key = mediaKeyFor(filename, 'image/png', { now: new Date(0), id: 'ffffffff' });
	return key.slice(key.lastIndexOf('/') + 1).replace(/-ffffffff\.png$/, '');
}
function slugOfKey(key: string): string {
	return key.slice(key.lastIndexOf('/') + 1).replace(/-[0-9a-f]{8}\.[a-z0-9]+$/, '');
}

const TINY_PNG_B64 = (() => {
	const png = new PNG({ width: 32, height: 20 });
	png.data.fill(128);
	return PNG.sync.write(png).toString('base64');
})();

const fakeTransformer: ImageProvider = {
	name: 'imgproxy',
	transforms: true,
	url(key) {
		const bytes = uploadedBytes.get(slugOfKey(key));
		// Nothing uploaded under this key: an empty body, which fails to decode
		// the same way a transformer's 404 would.
		if (!bytes) return 'data:application/octet-stream;base64,';
		try {
			PNG.sync.read(Buffer.from(bytes));
		} catch {
			// Not a decodable image — hand back the raw bytes so the encode throws.
			return `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
		}
		return `data:image/png;base64,${TINY_PNG_B64}`;
	}
};

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
	images = imageProviderFromEnv(process.env);

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
	// The `direct` provider fetches originals anonymously, exactly as a browser
	// will — so the bucket has to be readable without credentials here too.
	await storage.allowPublicRead();
	// A transforming provider in the deps: confirm computes blurhashes, like the
	// app route does on a deployed environment.
	deps = { db, storage, images: fakeTransformer };
});

afterAll(async () => {
	await db?.$client.end();
});

/** Presign + PUT the fixture; `filename` is the one the caller confirms with. */
async function uploadFixture(filename = 'Test Image.png'): Promise<{ key: string; size: number }> {
	const bytes = await readFile(FIXTURE);
	const ticket = await requestUpload(deps, {
		filename,
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
	uploadedBytes.set(servedSlug(filename), bytes);
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
			filename: 'Test Image.png',
			mime: 'image/png',
			size,
			// The fixture is generated at 320×200 (see tests/fixtures).
			width: 320,
			height: 200,
			createdBy: USER_ID
		});
		// The served key is minted at confirm, under uploads/ (FIX-15).
		expect(result.value.key).toMatch(/^uploads\/\d{4}\/\d{2}\/test-image-[0-9a-f]{8}\.png$/);
		// Confirm also encoded a blurhash from a tiny render.
		expect(result.value.blurhash).toMatch(/^.{20,}$/);
	});

	it('a corrupt upload confirms fine — it just gets no dimensions or blurhash', async () => {
		const garbage = Buffer.from('definitely not a PNG, but stored with an image mime');
		const ticket = await requestUpload(deps, {
			filename: 'broken.png',
			mime: 'image/png',
			size: garbage.byteLength
		});
		if (!ticket.ok) throw new Error('presign failed');
		const put = await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: garbage
		});
		expect(put.status).toBe(200);
		uploadedBytes.set(servedSlug('broken.png'), garbage);

		const result = await confirmUpload(deps, {
			key: ticket.value.key,
			filename: 'broken.png',
			createdBy: USER_ID
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.width).toBeNull();
		expect(result.value.blurhash).toBeNull();
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

	// FIX-15 (audit P1 media): the presigned PUT outlives confirm by up to 10
	// minutes. When the browser uploaded straight into the served key, a second
	// PUT after confirm replaced the object the row points at — for an SVG, the
	// sanitized bytes and the attachment header. Confirm must PRODUCE the served
	// object under its own key and the upload key must never be the served one.
	it('presigns into a quarantine key the public origin refuses to serve', async () => {
		const bytes = await readFile(FIXTURE);
		const ticket = await requestUpload(deps, {
			filename: 'quarantine.png',
			mime: 'image/png',
			size: bytes.byteLength
		});
		if (!ticket.ok) throw new Error(`presign failed: ${ticket.error}`);
		expect(ticket.value.key).toMatch(/^pending\//);

		const put = await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: bytes
		});
		expect(put.status).toBe(200);
		// Uploaded, but not readable anonymously: the bucket policy denies pending/.
		expect((await fetch(images.url(ticket.value.key))).status).toBe(403);
	});

	it('a PUT to the presigned URL after confirm cannot change the served object', async () => {
		const bytes = await readFile(FIXTURE);
		const ticket = await requestUpload(deps, {
			filename: 'immutable.png',
			mime: 'image/png',
			size: bytes.byteLength
		});
		if (!ticket.ok) throw new Error(`presign failed: ${ticket.error}`);
		await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: bytes
		});
		uploadedBytes.set(servedSlug('immutable.png'), bytes);

		const confirmed = await confirmUpload(deps, {
			key: ticket.value.key,
			filename: 'immutable.png',
			createdBy: USER_ID
		});
		expect(confirmed.ok).toBe(true);
		if (!confirmed.ok) return;
		const servedKey = confirmed.value.key!;
		expect(servedKey).not.toBe(ticket.value.key);
		expect(servedKey).toMatch(/^uploads\//);
		// The quarantine object is gone once the served one exists.
		expect(await deps.storage.statObject(ticket.value.key)).toBeNull();

		// The attacker's second PUT: same length (the signature pins it), different
		// bytes — the trailing IEND chunk CRC flipped is enough to tell apart.
		const tampered = Buffer.from(bytes);
		tampered[tampered.length - 1] ^= 0xff;
		const rePut = await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: tampered
		});
		expect(rePut.status).toBe(200);

		const served = await fetch(images.url(servedKey));
		expect(served.status).toBe(200);
		expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
	});

	it('rasters are served with an immutable cache header', async () => {
		const { key } = await uploadFixture('c.png');
		const confirmed = await confirmUpload(deps, { key, filename: 'c.png', createdBy: USER_ID });
		if (!confirmed.ok) throw new Error(confirmed.error);
		const served = await fetch(images.url(confirmed.value.key!));
		expect(served.status).toBe(200);
		expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
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

describe('origin serving (the direct/cloudflare source URL)', () => {
	// Under every provider except imgproxy the browser fetches the stored
	// object itself, so "is the bucket actually readable without credentials"
	// became a real, testable precondition rather than an imgproxy detail.
	it('serves an uploaded image anonymously from the public origin', async () => {
		const { key } = await uploadFixture('t.png');
		const confirmed = await confirmUpload(deps, { key, filename: 't.png', createdBy: USER_ID });
		if (!confirmed.ok) throw new Error(confirmed.error);

		const res = await fetch(images.url(confirmed.value.key!));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
	});

	it('404s for a key that was never uploaded', async () => {
		expect((await fetch(images.url('uploads/2026/07/nothing-here.png'))).status).toBe(404);
	});

	// audit M1, now enforced at rest: the stored bytes are sanitized at confirm
	// time and the object announces itself as a download. Both layers are
	// asserted, because either one alone would leave a hole — a sanitizer miss
	// needs the header, and a browser that ignores the header needs clean bytes.
	it('stores an uploaded SVG sanitized and marked as an attachment', async () => {
		const malicious = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">' +
				'<script>alert(document.cookie)</script>' +
				'<a href="javascript:alert(2)"><rect width="10" height="10"/></a></svg>',
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

		const confirmed = await confirmUpload(deps, {
			key: ticket.value.key,
			filename: 'evil.svg',
			createdBy: USER_ID
		});
		expect(confirmed.ok).toBe(true);
		if (!confirmed.ok) return;
		// SVGs never get a blurhash: nothing rasterizes them.
		expect(confirmed.value.blurhash).toBeNull();

		// FIX-15: the uploader re-PUTs the original payload to the still-valid
		// presigned URL after confirm. The served object must not be that URL's
		// target — otherwise this PUT restores the script and drops the header.
		const rePut = await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/svg+xml' },
			body: malicious
		});
		expect(rePut.status).toBe(200);

		// Exactly the URL the app embeds for an SVG row.
		const served = await fetch(images.url(confirmed.value.key!, { attachment: true }));
		expect(served.status).toBe(200);
		expect(served.headers.get('content-disposition')).toContain('attachment');

		const body = await served.text();
		expect(body).not.toContain('<script');
		expect(body).not.toContain('onload');
		expect(body).not.toContain('javascript:');
		expect(body).toContain('<rect'); // still a usable image, not an empty husk
	});

	it('refuses to confirm an "SVG" upload that is not an SVG document', async () => {
		const notSvg = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8');
		const ticket = await requestUpload(deps, {
			filename: 'fake.svg',
			mime: 'image/svg+xml',
			size: notSvg.byteLength
		});
		if (!ticket.ok) throw new Error('presign failed');
		await fetch(ticket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/svg+xml' },
			body: notSvg
		});
		const confirmed = await confirmUpload(deps, {
			key: ticket.value.key,
			filename: 'fake.svg',
			createdBy: USER_ID
		});
		expect(confirmed).toMatchObject({ ok: false, error: 'invalid-mime' });
	});
});

describe('backfillBlurhashes (pnpm media:blurhash)', () => {
	it('fills legacy rows, skips failures, and is a no-op when re-run', async () => {
		// Legacy row: confirmed without the imgproxy dep, like every pre-phase upload.
		const legacyDeps: MediaDeps = { db: deps.db, storage: deps.storage };
		const { key } = await uploadFixture('legacy.png');
		const legacy = await confirmUpload(legacyDeps, {
			key,
			filename: 'legacy.png',
			createdBy: USER_ID
		});
		if (!legacy.ok) throw new Error('confirm failed');
		expect(legacy.value.blurhash).toBeNull();

		// A row whose stored object is corrupt: the backfill must report it and
		// carry on, not abort the run.
		const garbage = Buffer.from('not an image');
		const badTicket = await requestUpload(legacyDeps, {
			filename: 'bad.png',
			mime: 'image/png',
			size: garbage.byteLength
		});
		if (!badTicket.ok) throw new Error('presign failed');
		await fetch(badTicket.value.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: garbage
		});
		uploadedBytes.set(servedSlug('bad.png'), garbage);
		const bad = await confirmUpload(legacyDeps, {
			key: badTicket.value.key,
			filename: 'bad.png',
			createdBy: USER_ID
		});
		if (!bad.ok) throw new Error('confirm failed');

		const logged: string[] = [];
		const first = await backfillBlurhashes(
			{ db, images: fakeTransformer },
			{ log: (line) => logged.push(line) }
		);
		expect(first.filled).toBeGreaterThanOrEqual(1);
		expect(first.failed).toBeGreaterThanOrEqual(1);
		expect(logged.join('\n')).toContain(bad.value.key); // the served key, not the quarantine one

		const [filledRow] = await db.select().from(media).where(eq(media.id, legacy.value.id));
		expect(filledRow.blurhash).toMatch(/^.{20,}$/);

		// Idempotent: everything fillable is filled; only the corrupt row retries.
		const second = await backfillBlurhashes({ db, images: fakeTransformer }, {});
		expect(second.filled).toBe(0);
		expect(second.failed).toBe(first.failed);
	});
});

// FIX-15 (audit P2 'admin media library unbounded'): the library and the
// picker read every row on each editor load. Listing is paginated now.
describe('listMedia pagination', () => {
	it('pages newest-first with totals, and an empty page past the end', async () => {
		const first = await listMedia({ db }, { page: 1, pageSize: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.total).toBeGreaterThanOrEqual(3);
		expect(first.pageCount).toBe(Math.ceil(first.total / 2));
		expect(first.page).toBe(1);
		const [a, b] = first.items;
		expect(a.createdAt.getTime()).toBeGreaterThanOrEqual(b.createdAt.getTime());

		const second = await listMedia({ db }, { page: 2, pageSize: 2 });
		expect(second.items.map((r) => r.id)).not.toContain(a.id);
		expect(second.page).toBe(2);

		const beyond = await listMedia({ db }, { page: first.pageCount + 5, pageSize: 2 });
		expect(beyond.items).toEqual([]);
		expect(beyond.total).toBe(first.total);
	});
});

describe('alt, delete and reference checks', () => {
	it('updates alt text', async () => {
		const { key } = await uploadFixture('a.png');
		const created = await confirmUpload(deps, { key, filename: 'a.png', createdBy: USER_ID });
		if (!created.ok) throw new Error('confirm failed');
		const updated = await updateMediaAlt(deps, created.value.id, 'Un somn liniștit');
		expect(updated.ok && updated.value.alt).toBe('Un somn liniștit');
	});

	it('refuses deletion while referenced, deletes row + object afterwards', async () => {
		const { key } = await uploadFixture('b.png');
		const created = await confirmUpload(deps, { key, filename: 'b.png', createdBy: USER_ID });
		if (!created.ok) throw new Error('confirm failed');
		const id = created.value.id;

		const specCheck: MediaReferenceCheck = {
			name: 'spec-articles',
			isReferenced: async (_db, mediaId) => mediaId === id
		};
		expect(await deleteMedia({ ...deps, referenceChecks: [specCheck] }, id)).toMatchObject({
			ok: false,
			error: 'referenced',
			detail: 'spec-articles'
		});

		const deleted = await deleteMedia({ ...deps, referenceChecks: [] }, id);
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
		const deleted = await deleteMedia({ ...deps, referenceChecks: [] }, row.id);
		expect(deleted.ok).toBe(true);
	});
});
