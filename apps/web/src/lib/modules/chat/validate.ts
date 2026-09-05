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

/**
 * Pure: cap the history sent to the provider to the most recent messages,
 * then drop any leading non-`user` turns — the Messages API rejects a
 * conversation whose first turn is `assistant`, and a newest-N window over
 * alternating turns starts with one every other message (FIX-14).
 */
export function capHistory(messages: ChatMessage[], limit: number = HISTORY_LIMIT): ChatMessage[] {
	const capped = messages.length <= limit ? messages : messages.slice(-limit);
	const firstUser = capped.findIndex((m) => m.role === 'user');
	if (firstUser <= 0) return firstUser === 0 ? capped : [];
	return capped.slice(firstUser);
}
