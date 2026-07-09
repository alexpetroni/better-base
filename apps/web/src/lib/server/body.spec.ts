import { describe, expect, it } from 'vitest';
import { readJsonBounded } from './body.ts';

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
	return new Request('http://test.local/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body
	});
}

describe('readJsonBounded (audit L1: size decision before buffering)', () => {
	it('parses a small valid body', async () => {
		expect(await readJsonBounded(jsonRequest('{"message":"salut"}'), 1024)).toEqual({
			ok: true,
			value: { message: 'salut' }
		});
	});

	it('rejects invalid JSON as invalid, not too-large', async () => {
		expect(await readJsonBounded(jsonRequest('{nope'), 1024)).toEqual({
			ok: false,
			reason: 'invalid'
		});
	});

	it('rejects an over-cap declared Content-Length without reading the body', async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(new Uint8Array(1024));
			}
		});
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-length': '99999999' },
			body: stream,
			// @ts-expect-error Node needs half-duplex for stream bodies; not in lib.dom types
			duplex: 'half'
		});
		expect(await readJsonBounded(request, 1024)).toEqual({ ok: false, reason: 'too-large' });
		// undici pre-pulls at most one chunk when the Request is constructed;
		// the bounded reader itself never touched the stream.
		expect(pulled).toBeLessThanOrEqual(1);
	});

	it('stops reading a chunked body (no Content-Length) as soon as the cap is crossed', async () => {
		let pulled = 0;
		// An endless body that never advertises its size — request.json() would
		// buffer it forever; the bounded reader must bail after ~cap bytes.
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(new Uint8Array(1024).fill(97));
			}
		});
		const request = new Request('http://test.local/x', {
			method: 'POST',
			body: endless,
			// @ts-expect-error Node needs half-duplex for stream bodies; not in lib.dom types
			duplex: 'half'
		});
		expect(await readJsonBounded(request, 4 * 1024)).toEqual({ ok: false, reason: 'too-large' });
		// 4 KiB cap at 1 KiB per pull: cancelled within a few chunks, not endless.
		expect(pulled).toBeLessThanOrEqual(8);
	});

	it('accepts a body exactly at the cap', async () => {
		const payload = JSON.stringify({ pad: 'x'.repeat(100) });
		expect(await readJsonBounded(jsonRequest(payload), payload.length)).toEqual({
			ok: true,
			value: { pad: 'x'.repeat(100) }
		});
	});
});
