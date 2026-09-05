import { randomUUID } from 'node:crypto';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { formatServerError } from '../../server/log.ts';
import type { ChatMessage, ChatProvider, ChatStreamEvent, ChatStreamOptions } from './provider.ts';

export const ANTHROPIC_CHAT_MODEL = 'claude-sonnet-5';

/**
 * Cap on time-to-response for one API attempt; override via
 * ANTHROPIC_TIMEOUT_MS. The SDK arms the timer around the fetch itself
 * (headers), so a healthy long-running stream is never cut off mid-reply.
 * Sized with ANTHROPIC_MAX_RETRIES so the worst case (every attempt times
 * out) stays under the route's `maxDuration = 60` (FIX-14; README).
 */
export const ANTHROPIC_TIMEOUT_MS_DEFAULT = 20_000;
export const ANTHROPIC_MAX_RETRIES = 1;

/**
 * A stream that emits nothing for this long is dead (a healthy reply emits
 * tokens continuously); abort it instead of holding the request open until
 * the platform kills it with no frame sent. Armed only once the first event
 * has arrived (FIX-17): before that the SDK's own `timeout` × attempts is
 * the budget, and an inactivity abort merged into the request signal would
 * cancel a slow attempt before the SDK could time it out and retry.
 */
export const ANTHROPIC_INACTIVITY_MS_DEFAULT = 15_000;

/**
 * Hard cap on time-to-first-event: every SDK attempt may time out, plus
 * `inactivityMs` of slack for the retry backoff and a response whose headers
 * arrived but whose body never yields a frame (the SDK does not watch that).
 * With the defaults 20 s × 2 + 15 s = 55 s, under the route's `maxDuration`.
 */
export function firstEventTimeoutMs(input: {
	timeoutMs: number;
	maxRetries: number;
	inactivityMs: number;
}): number {
	return input.timeoutMs * (input.maxRetries + 1) + input.inactivityMs;
}

export interface AnthropicProviderOptions {
	timeoutMs?: number;
	maxRetries?: number;
	inactivityMs?: number;
	/** Test seam: route the SDK's HTTP through this fetch. Never set in app code. */
	fetchFn?: ClientOptions['fetch'];
}

/**
 * Streaming Anthropic implementation. Constructed ONLY by the server barrel
 * when `CHAT_PROVIDER=anthropic` — no test may instantiate it with a real key,
 * and the constructor refuses an empty key so a misconfiguration can never
 * fall through to the SDK's own env lookup.
 *
 * Calls are bounded by `timeout`/`maxRetries`/inactivity (audit Theme C,
 * FIX-14), and the per-stream abort signal is threaded into the request so a
 * client disconnect stops the upstream stream instead of billing tokens into
 * the void. Thinking is disabled and `stop_reason` is read — see README
 * "Provider settings".
 */
export function createAnthropicChatProvider(
	apiKey: string,
	options: AnthropicProviderOptions = {}
): ChatProvider {
	if (!apiKey) throw new Error('AnthropicChatProvider requires a non-empty API key');
	const timeoutMs = options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS_DEFAULT;
	const maxRetries = options.maxRetries ?? ANTHROPIC_MAX_RETRIES;
	const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries, fetch: options.fetchFn });
	const inactivityMs = options.inactivityMs ?? ANTHROPIC_INACTIVITY_MS_DEFAULT;
	const firstEventMs = firstEventTimeoutMs({ timeoutMs, maxRetries, inactivityMs });
	return {
		kind: 'anthropic',
		async *stream(
			messages: ChatMessage[],
			{ system, maxTokens, signal }: ChatStreamOptions
		): AsyncIterable<ChatStreamEvent> {
			// Two-phase watchdog (FIX-17): until the first event, the SDK owns
			// the budget (timeout × attempts, retries included) and this only
			// caps the whole thing; from the first event on, inactivity.
			const watchdog = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const arm = (ms: number, reason: string) => {
				clearTimeout(timer);
				timer = setTimeout(() => watchdog.abort(new Error(reason)), ms);
			};
			try {
				arm(firstEventMs, `chat stream produced no event within ${firstEventMs} ms`);
				const stream = client.messages.stream(
					{
						model: ANTHROPIC_CHAT_MODEL,
						max_tokens: maxTokens,
						system,
						thinking: { type: 'disabled' },
						messages: messages.map(({ role, content }) => ({ role, content }))
					},
					{ signal: signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal }
				);
				let stop: ChatStreamEvent | undefined;
				for await (const event of stream) {
					arm(inactivityMs, `chat stream inactive for ${inactivityMs} ms`);
					if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
						yield { delta: event.delta.text };
					} else if (event.type === 'message_delta') {
						const reason = event.delta.stop_reason;
						if (reason === 'max_tokens' || reason === 'refusal') stop = { stop: reason };
					}
				}
				if (stop) yield stop;
			} catch (error) {
				// The client going away is not a provider failure — and nobody is
				// left to receive a frame anyway.
				if (signal?.aborted) throw error;
				const failure = watchdog.signal.aborted ? (watchdog.signal.reason as Error) : error;
				logProviderError(failure);
				throw failure;
			} finally {
				clearTimeout(timer);
			}
		}
	};
}

/** One JSON line per failed call: SDK error class + upstream status (FIX-14). */
function logProviderError(error: unknown): void {
	const status = (error as { status?: unknown })?.status;
	// SDK error classes (RateLimitError, AuthenticationError, …) keep `name`
	// at 'Error'; the class is what tells an operator what went wrong.
	const name = error instanceof Error ? error.constructor.name : 'Error';
	const message = error instanceof Error ? error.message : String(error);
	console.error(
		formatServerError({
			error: null,
			errorId: randomUUID(),
			status: typeof status === 'number' ? status : 0,
			method: 'POST',
			path: '/api/chat',
			message: `anthropic ${name}${typeof status === 'number' ? ` status=${status}` : ''}: ${message}`
		})
	);
}
