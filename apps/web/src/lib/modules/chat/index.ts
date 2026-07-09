// Universal barrel: chat UI components, types and pure helpers. Everything
// that signs tokens or touches the db/provider env lives in ./server.
export { default as ChatPanel } from './ChatPanel.svelte';
export { default as ChatWidget } from './ChatWidget.svelte';
export { CHAT_ERRORS } from './copy.ts';
export { createMockChatProvider, mockReplyFor } from './mock-provider.ts';
export type { ChatMessage, ChatProvider, ChatRole, ChatStreamOptions } from './provider.ts';
export { selectChatProvider, type ChatProviderEnv, type ChatProviderSelection } from './select.ts';
export {
	capHistory,
	HISTORY_LIMIT,
	MAX_MESSAGE_CHARS,
	validateChatMessage,
	type MessageValidation
} from './validate.ts';
