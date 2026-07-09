import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './provider.ts';
import { capHistory, HISTORY_LIMIT, MAX_MESSAGE_CHARS, validateChatMessage } from './validate.ts';

describe('validateChatMessage', () => {
	it('accepts a normal message and trims it', () => {
		expect(validateChatMessage('  Salut!  ')).toEqual({ ok: true, message: 'Salut!' });
	});

	it('accepts exactly the maximum length', () => {
		const max = 'a'.repeat(MAX_MESSAGE_CHARS);
		expect(validateChatMessage(max)).toEqual({ ok: true, message: max });
	});

	it('rejects over-long messages', () => {
		expect(validateChatMessage('a'.repeat(MAX_MESSAGE_CHARS + 1))).toEqual({
			ok: false,
			reason: 'too-long'
		});
	});

	it('rejects empty and whitespace-only messages', () => {
		expect(validateChatMessage('')).toEqual({ ok: false, reason: 'empty' });
		expect(validateChatMessage('   \n ')).toEqual({ ok: false, reason: 'empty' });
	});

	it('rejects non-string payloads', () => {
		for (const bad of [undefined, null, 42, { message: 'x' }, ['x']]) {
			expect(validateChatMessage(bad)).toEqual({ ok: false, reason: 'invalid' });
		}
	});
});

describe('capHistory', () => {
	const message = (i: number): ChatMessage => ({
		role: i % 2 === 0 ? 'user' : 'assistant',
		content: `m${i}`
	});

	it('returns short histories unchanged', () => {
		const history = [message(0), message(1)];
		expect(capHistory(history)).toEqual(history);
	});

	it('keeps only the most recent messages beyond the limit', () => {
		const history = Array.from({ length: HISTORY_LIMIT + 7 }, (_, i) => message(i));
		const capped = capHistory(history);
		expect(capped).toHaveLength(HISTORY_LIMIT);
		expect(capped[0]).toEqual(message(7));
		expect(capped.at(-1)).toEqual(message(HISTORY_LIMIT + 6));
	});
});
