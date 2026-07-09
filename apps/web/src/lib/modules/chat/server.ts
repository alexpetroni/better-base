// Server module barrel: schema, the chat service, and the env-bound provider
// singleton. Mock is the default everywhere; the Anthropic provider is live
// ONLY when CHAT_PROVIDER=anthropic AND ANTHROPIC_API_KEY are both set.
import { env } from '$env/dynamic/private';
import { createAnthropicChatProvider } from './anthropic-provider.ts';
import { createMockChatProvider } from './mock-provider.ts';
import type { ChatProvider } from './provider.ts';
import { selectChatProvider } from './select.ts';

export { ANTHROPIC_CHAT_MODEL, createAnthropicChatProvider } from './anthropic-provider.ts';
export { CHAT_ERRORS } from './copy.ts';
export { createMockChatProvider, mockReplyFor } from './mock-provider.ts';
export type { ChatMessage, ChatProvider, ChatRole, ChatStreamOptions } from './provider.ts';
export { CHAT_RATE_LIMIT, type ChatRateConfig } from './rate-limit.ts';
export {
	chatMessages,
	chatRateLimits,
	chatSessions,
	type ChatMessageRow,
	type ChatSessionRow
} from './schema.ts';
export { selectChatProvider, type ChatProviderSelection } from './select.ts';
export {
	CHAT_MAX_TOKENS,
	CHAT_RETENTION_DAYS,
	handleChatMessage,
	pruneChatSessions,
	type ChatDeps,
	type ChatInput,
	type ChatOutcome
} from './service.ts';
export { signSessionToken, verifySessionToken } from './token.ts';
export { HISTORY_LIMIT, MAX_MESSAGE_CHARS } from './validate.ts';

export const CHAT_SESSION_COOKIE = 'chat_session';

let providerInstance: ChatProvider | undefined;

/** The app's chat provider, selected once per process from env (fails fast). */
export function getChatProvider(): ChatProvider {
	if (!providerInstance) {
		const selection = selectChatProvider(env);
		providerInstance =
			selection.kind === 'anthropic'
				? createAnthropicChatProvider(selection.apiKey)
				: createMockChatProvider();
	}
	return providerInstance;
}

/** HMAC secret for chat session cookie tokens (reuses the auth secret). */
export function getChatSecret(): string {
	if (!env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is not set');
	return env.BETTER_AUTH_SECRET;
}

// Fail fast at boot: hooks.server.ts imports this barrel, so a misconfigured
// provider (CHAT_PROVIDER=anthropic without ANTHROPIC_API_KEY) stops the
// server before it can accept a chat request.
getChatProvider();
