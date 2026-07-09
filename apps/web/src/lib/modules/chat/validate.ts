import type { ChatMessage } from './provider.ts';

export const MAX_MESSAGE_CHARS = 2000;

/** How many messages of history (user + assistant) are sent to the provider. */
export const HISTORY_LIMIT = 20;

export type MessageValidation =
	{ ok: true; message: string } | { ok: false; reason: 'invalid' | 'empty' | 'too-long' };

/** Pure: a chat message must be a non-empty string of at most 2000 chars. */
export function validateChatMessage(raw: unknown): MessageValidation {
	if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
	const message = raw.trim();
	if (!message) return { ok: false, reason: 'empty' };
	if (message.length > MAX_MESSAGE_CHARS) return { ok: false, reason: 'too-long' };
	return { ok: true, message };
}

/** Pure: cap the history sent to the provider to the most recent messages. */
export function capHistory(messages: ChatMessage[], limit: number = HISTORY_LIMIT): ChatMessage[] {
	return messages.length <= limit ? messages : messages.slice(-limit);
}
