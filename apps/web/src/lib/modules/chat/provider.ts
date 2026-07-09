/**
 * Chat provider abstraction: the app talks to any LLM through this interface.
 * Dev and ALL tests run on the deterministic mock; the Anthropic implementation
 * is opt-in via env (`CHAT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`), see
 * `select.ts` and the server barrel.
 */
export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface ChatStreamOptions {
	/** Persona system prompt for the active site. */
	system: string;
	maxTokens: number;
}

export interface ChatProvider {
	/** Which implementation is live — asserted by tests, logged nowhere else. */
	readonly kind: 'mock' | 'anthropic';
	stream(messages: ChatMessage[], options: ChatStreamOptions): AsyncIterable<string>;
}
