import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { ChatMessage, ChatProvider, ChatStreamOptions } from './provider.ts';

export const ANTHROPIC_CHAT_MODEL = 'claude-sonnet-5';

/**
 * Cap on time-to-response for one API call; override via ANTHROPIC_TIMEOUT_MS.
 * The SDK arms the timer around the fetch itself (headers), so a healthy
 * long-running stream is never cut off mid-reply.
 */
export const ANTHROPIC_TIMEOUT_MS_DEFAULT = 60_000;
export const ANTHROPIC_MAX_RETRIES = 2;

export interface AnthropicProviderOptions {
	timeoutMs?: number;
	maxRetries?: number;
	/** Test seam: route the SDK's HTTP through this fetch. Never set in app code. */
	fetchFn?: ClientOptions['fetch'];
}

/**
 * Streaming Anthropic implementation. Constructed ONLY by the server barrel
 * when `CHAT_PROVIDER=anthropic` — no test may instantiate it with a real key,
 * and the constructor refuses an empty key so a misconfiguration can never
 * fall through to the SDK's own env lookup.
 *
 * Calls are bounded by `timeout`/`maxRetries` (audit Theme C), and the
 * per-stream abort signal is threaded into the request so a client disconnect
 * stops the upstream stream instead of billing tokens into the void.
 */
export function createAnthropicChatProvider(
	apiKey: string,
	options: AnthropicProviderOptions = {}
): ChatProvider {
	if (!apiKey) throw new Error('AnthropicChatProvider requires a non-empty API key');
	const client = new Anthropic({
		apiKey,
		timeout: options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS_DEFAULT,
		maxRetries: options.maxRetries ?? ANTHROPIC_MAX_RETRIES,
		fetch: options.fetchFn
	});
	return {
		kind: 'anthropic',
		async *stream(messages: ChatMessage[], { system, maxTokens, signal }: ChatStreamOptions) {
			const stream = client.messages.stream(
				{
					model: ANTHROPIC_CHAT_MODEL,
					max_tokens: maxTokens,
					system,
					messages: messages.map(({ role, content }) => ({ role, content }))
				},
				{ signal }
			);
			for await (const event of stream) {
				if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
					yield event.delta.text;
				}
			}
		}
	};
}
