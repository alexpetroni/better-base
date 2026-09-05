import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from './provider.ts';
import { chatSseStream } from './sse.ts';

// Audit Theme C (resilience #4): the SSE response must propagate a client
// disconnect upstream. Before the fix the route had no cancel() — the
// provider stream ran (and billed) to completion against a dead request.

const decoder = new TextDecoder();
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function frames(raw: string): unknown[] {
	return raw
		.split('\n\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line.replace(/^data: /, '')));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	let out = '';
	for await (const chunk of stream) out += decoder.decode(chunk);
	return out;
}

describe('chatSseStream', () => {
	it('frames deltas then a done marker', async () => {
		async function* chunks() {
			yield { delta: 'Salut ' };
			yield { delta: 'lume' };
		}
		const raw = await readAll(chatSseStream(chunks(), new AbortController()));
		expect(frames(raw)).toEqual([{ delta: 'Salut ' }, { delta: 'lume' }, { done: true }]);
	});

	it('emits an error frame when the provider fails mid-stream', async () => {
		async function* chunks(): AsyncIterable<ChatStreamEvent> {
			yield { delta: 'a' };
			throw new Error('provider boom');
		}
		const raw = await readAll(chatSseStream(chunks(), new AbortController()));
		const list = frames(raw) as Record<string, unknown>[];
		expect(list[0]).toEqual({ delta: 'a' });
		expect(list[1]).toHaveProperty('error');
	});

	it('cancel() aborts the upstream and stops the reply (streamed to completion before the fix)', async () => {
		const abort = new AbortController();
		let yielded = 0;
		let ranToCompletion = false;
		async function* chunks() {
			for (let i = 0; i < 50; i++) {
				if (abort.signal.aborted) return;
				await tick(5);
				yield { delta: `c${i} ` };
				yielded += 1;
			}
			ranToCompletion = true;
		}
		const stream = chatSseStream(chunks(), abort);
		const reader = stream.getReader();
		await reader.read(); // the first frame reached the client…
		await reader.cancel(); // …then it disconnected

		expect(abort.signal.aborted).toBe(true);
		await tick(100); // give a buggy implementation time to keep going
		expect(ranToCompletion).toBe(false);
		expect(yielded).toBeLessThan(50);
	}, 3_000);

	// FIX-14: a truncated (max_tokens) or declined (refusal) reply ends with
	// its own terminal frame — never `done`, which would let the widget show
	// a half answer as complete.
	it('forwards a stop event as the terminal frame instead of done', async () => {
		async function* chunks(): AsyncIterable<ChatStreamEvent> {
			yield { delta: 'Un început' };
			yield { stop: 'max_tokens' };
		}
		const raw = await readAll(chatSseStream(chunks(), new AbortController()));
		expect(frames(raw)).toEqual([{ delta: 'Un început' }, { stop: 'max_tokens' }]);
	});
});
