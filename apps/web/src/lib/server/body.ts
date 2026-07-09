/**
 * Byte-bounded JSON body reading (audit L1). `request.json()` buffers the
 * whole body before any size decision, and a Content-Length check alone is
 * theater — the header is client-supplied and absent on chunked uploads.
 * This reads the stream and stops the moment the cap is crossed, so an
 * oversized body is rejected after at most `maxBytes` + one chunk, never
 * fully buffered or parsed. Framework-free (web-standard Request only).
 */

export type BoundedJsonResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: 'too-large' | 'invalid' };

export async function readJsonBounded(
	request: Request,
	maxBytes: number
): Promise<BoundedJsonResult> {
	// A declared length over the cap is refused without reading anything;
	// an honest small body is still re-counted below (headers can lie).
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too-large' };

	if (!request.body) return { ok: false, reason: 'invalid' };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { ok: false, reason: 'too-large' };
		}
		chunks.push(value);
	}

	try {
		return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}
