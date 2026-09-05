import type { Storage } from '../media/storage.ts';
import { INVOICE_DOC_PREFIX } from './documents.ts';

/**
 * One-off move of the documents an earlier deploy wrote under `invoices/`
 * in the MEDIA bucket (audit P0 #4: that bucket is publicly bound under the
 * default image provider) into the private fiscal bucket. Keys are kept
 * verbatim — they are the pre-FIX-12 unversioned renders, archived as the
 * files customers actually received; the app renders the current version
 * under its own versioned key when a document is next requested.
 *
 * Idempotent and crash-safe in either order: an object already present in
 * the fiscal bucket is never overwritten (the private copy is the record),
 * and the public copy is deleted whether or not it had to be copied first.
 */
export async function migrateFiscalObjects(buckets: {
	from: Pick<Storage, 'listKeys' | 'getObjectBytes' | 'statObject' | 'deleteObject'>;
	to: Pick<Storage, 'statObject' | 'putObject'>;
}): Promise<{ moved: number; alreadyThere: number }> {
	const result = { moved: 0, alreadyThere: 0 };
	for (const key of await buckets.from.listKeys(INVOICE_DOC_PREFIX)) {
		if (await buckets.to.statObject(key)) {
			result.alreadyThere += 1;
		} else {
			const source = await buckets.from.statObject(key);
			const bytes = await buckets.from.getObjectBytes(key);
			await buckets.to.putObject(key, bytes, source?.mime ?? 'application/octet-stream');
			result.moved += 1;
		}
		await buckets.from.deleteObject(key);
	}
	return result;
}
