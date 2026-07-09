import { CHAT_ERRORS } from './copy.ts';

/**
 * SSE framing for a chat reply, with client-disconnect propagation (audit
 * Theme C): when the visitor closes the tab, the runtime calls the stream's
 * `cancel()`, which fires `abort` — the same controller whose signal the chat
 * service threads into the provider — so the upstream LLM call stops instead
 * of running (and billing) to completion against a dead request.
 *
 * Frames: `data: {"delta": …}` per chunk, then `data: {"done": true}`; a
 * mid-stream provider failure emits `data: {"error": …}` (ro copy the widget
 * renders verbatim). After a cancel nothing is enqueued or closed — touching
 * an already-cancelled controller throws.
 */
export function chatSseStream(
	chunks: AsyncIterable<string>,
	abort: AbortController
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const frame = (payload: object) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
			try {
				for await (const chunk of chunks) {
					if (abort.signal.aborted) return;
					frame({ delta: chunk });
				}
				if (abort.signal.aborted) return;
				frame({ done: true });
			} catch {
				// Provider failed mid-stream; tell the widget instead of hanging —
				// unless the client is already gone.
				if (abort.signal.aborted) return;
				frame({ error: CHAT_ERRORS.stream });
			} finally {
				if (!abort.signal.aborted) controller.close();
			}
		},
		cancel() {
			abort.abort();
		}
	});
}
