import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatProvider, ChatStreamOptions } from './provider.ts';

export const ANTHROPIC_CHAT_MODEL = 'claude-sonnet-5';

/**
 * Streaming Anthropic implementation. Constructed ONLY by the server barrel
 * when `CHAT_PROVIDER=anthropic` — no test may instantiate it with a real key,
 * and the constructor refuses an empty key so a misconfiguration can never
 * fall through to the SDK's own env lookup.
 */
export function createAnthropicChatProvider(apiKey: string): ChatProvider {
	if (!apiKey) throw new Error('AnthropicChatProvider requires a non-empty API key');
	const client = new Anthropic({ apiKey });
	return {
		kind: 'anthropic',
		async *stream(messages: ChatMessage[], { system, maxTokens }: ChatStreamOptions) {
			const stream = client.messages.stream({
				model: ANTHROPIC_CHAT_MODEL,
				max_tokens: maxTokens,
				system,
				messages: messages.map(({ role, content }) => ({ role, content }))
			});
			for await (const event of stream) {
				if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
					yield event.delta.text;
				}
			}
		}
	};
}
