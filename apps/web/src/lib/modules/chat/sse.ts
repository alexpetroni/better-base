import { CHAT_ERRORS } from './copy.ts';
import type { ChatStreamEvent } from './provider.ts';

/**
 * SSE framing for a chat reply, with client-disconnect propagation (audit
 * Theme C): when the visitor closes the tab, the runtime calls the stream's
 * `cancel()`, which fires `abort` — the same controller whose signal the chat
 * service threads into the provider — so the upstream LLM call stops instead
 * of running (and billing) to completion against a dead request.
 *
 * Frames: `data: {"delta": …}` per chunk, then exactly one terminal frame:
 * `data: {"done": true}` for a complete reply, `data: {"stop": "max_tokens" |
 * "refusal"}` for a truncated/declined one (FIX-14), or `data: {"error": …}`
 * (ro copy the widget renders verbatim) when the provider failed mid-stream.
 * A stream that closes with no terminal frame is a failure the widget marks
 * itself. After a cancel nothing is enqueued or closed — touching an
 * already-cancelled controller throws.
 */
export function chatSseStream(
	chunks: AsyncIterable<ChatStreamEvent>,
	abort: AbortController
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const frame = (payload: object) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
			try {
				let stopped = false;
				for await (const event of chunks) {
					if (abort.signal.aborted) return;
					if ('stop' in event) stopped = true;
					frame(event);
				}
				if (abort.signal.aborted) return;
				if (!stopped) frame({ done: true });
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
