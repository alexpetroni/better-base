import { describe, expect, it } from 'vitest';
import { POST } from './+server.ts';

/**
 * Route-level guard (audit L1): an oversized chat body is refused with 413
 * BEFORE anything else runs — no db construction, no rate-limit rows, no
 * provider call. The event carries only `request` on purpose: touching any
 * other field would throw, proving the body cap is the first gate.
 */
describe('POST /api/chat body cap', () => {
	it('rejects a body over 32 KiB with 413 before doing any work', async () => {
		const request = new Request('http://test.local/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message: 'a'.repeat(64 * 1024) })
		});
		const response = await POST({ request } as Parameters<typeof POST>[0]);
		expect(response.status).toBe(413);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBeTruthy();
	});
});
