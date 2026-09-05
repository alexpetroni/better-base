import { beforeAll, describe, expect, it } from 'vitest';
import { invoiceStorageConfigFromEnv, storageConfigFromEnv } from '../media/env.ts';
import { createStorage, type Storage } from '../media/storage.ts';
import { INVOICE_DOC_PREFIX, invoiceDocumentKey } from './documents.ts';
import { EFACTURA_RENDERER_VERSION } from './efactura.ts';
import { migrateFiscalObjects } from './fiscal-storage.ts';
import { INVOICE_PDF_RENDERER_VERSION } from './pdf.ts';

// FIX-12 (audit P0 #4 "fiscal documents live in the publicly bound media
// bucket"): documents go to a SEPARATE private bucket, keyed by renderer
// version so a renderer fix re-renders instead of freezing a defective file,
// and the objects an earlier deploy wrote under `invoices/` in the media
// bucket are moved by an idempotent script. The bucket half runs against the
// real MinIO of the compose stack.

describe('fiscal bucket configuration', () => {
	const base = {
		S3_ENDPOINT: 'http://localhost:9000',
		S3_ACCESS_KEY: 'k',
		S3_SECRET_KEY: 's',
		S3_BUCKET: 'site-media'
	};

	it('defaults to the media bucket name + "-fiscal"', () => {
		const cfg = invoiceStorageConfigFromEnv(base);
		expect(cfg.bucket).toBe('site-media-fiscal');
		expect(cfg).toMatchObject({ endpoint: base.S3_ENDPOINT, accessKey: 'k', secretKey: 's' });
	});

	it('S3_INVOICE_BUCKET selects the bucket explicitly', () => {
		expect(invoiceStorageConfigFromEnv({ ...base, S3_INVOICE_BUCKET: 'site-fiscal' }).bucket).toBe(
			'site-fiscal'
		);
	});

	it('no media bucket → no derived fiscal bucket (the boot check reports S3_BUCKET)', () => {
		expect(invoiceStorageConfigFromEnv({ ...base, S3_BUCKET: '' }).bucket).toBe('');
	});
});

describe('versioned document keys', () => {
	it('carry the renderer version, so a renderer fix changes the key', () => {
		expect(invoiceDocumentKey('inv-1', 'pdf')).toBe(
			`${INVOICE_DOC_PREFIX}inv-1.${INVOICE_PDF_RENDERER_VERSION}.pdf`
		);
		expect(invoiceDocumentKey('inv-1', 'xml')).toBe(
			`${INVOICE_DOC_PREFIX}inv-1.${EFACTURA_RENDERER_VERSION}.xml`
		);
		// The pre-FIX-12 renders were `invoices/<id>.<fmt>` (version 1 in all but
		// name); both renderers changed in FIX-12, so neither is at 1 any more.
		expect(INVOICE_PDF_RENDERER_VERSION).toBeGreaterThan(1);
		expect(EFACTURA_RENDERER_VERSION).toBeGreaterThan(1);
	});
});

describe('moving legacy documents out of the media bucket (integration)', () => {
	let media: Storage;
	let fiscal: Storage;
	const legacy = ['invoices/mig-a.pdf', 'invoices/mig-a.xml', 'invoices/mig-b.pdf'];

	beforeAll(async () => {
		media = createStorage(storageConfigFromEnv(process.env));
		fiscal = createStorage(invoiceStorageConfigFromEnv(process.env));
		await media.ensureBucket();
		await fiscal.ensureBucket();
		for (const key of [...legacy, 'uploads/mig-keep.txt']) {
			await media.deleteObject(key);
			await fiscal.deleteObject(key);
		}
	});

	it('moves every invoices/ object, leaves the rest, and is idempotent', async () => {
		for (const key of legacy) await media.putObject(key, `legacy ${key}`, 'application/pdf');
		await media.putObject('uploads/mig-keep.txt', 'not fiscal', 'text/plain');

		const first = await migrateFiscalObjects({ from: media, to: fiscal });
		expect(first).toEqual({ moved: 3, alreadyThere: 0 });

		expect(await media.listKeys(INVOICE_DOC_PREFIX)).toEqual([]);
		expect((await fiscal.listKeys(INVOICE_DOC_PREFIX)).filter((k) => k.includes('mig-'))).toEqual(
			[...legacy].sort()
		);
		for (const key of legacy) {
			expect(new TextDecoder().decode(await fiscal.getObjectBytes(key))).toBe(`legacy ${key}`);
		}
		expect(await media.statObject('uploads/mig-keep.txt')).not.toBeNull();

		// A second run finds nothing to do.
		expect(await migrateFiscalObjects({ from: media, to: fiscal })).toEqual({
			moved: 0,
			alreadyThere: 0
		});

		// A rerun after a partial move (object copied, delete not reached) does
		// not overwrite the private copy and still clears the public one.
		await media.putObject('invoices/mig-a.pdf', 'stale public copy', 'application/pdf');
		expect(await migrateFiscalObjects({ from: media, to: fiscal })).toEqual({
			moved: 0,
			alreadyThere: 1
		});
		expect(await media.statObject('invoices/mig-a.pdf')).toBeNull();
		expect(new TextDecoder().decode(await fiscal.getObjectBytes('invoices/mig-a.pdf'))).toBe(
			'legacy invoices/mig-a.pdf'
		);
	}, 30_000);
});
