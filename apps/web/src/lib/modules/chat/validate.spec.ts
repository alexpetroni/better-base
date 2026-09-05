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
		// An even offset so the newest-20 window starts on a user turn and the
		// cap is exact (odd offsets additionally drop the leading assistant).
		const history = Array.from({ length: HISTORY_LIMIT + 8 }, (_, i) => message(i));
		const capped = capHistory(history);
		expect(capped).toHaveLength(HISTORY_LIMIT);
		expect(capped[0]).toEqual(message(8));
		expect(capped.at(-1)).toEqual(message(HISTORY_LIMIT + 7));
	});
});

// FIX-14 (audit 2026-09-03 "Chat"): the Messages API rejects a conversation
// whose first turn is not `user`. With alternating turns the 11th message
// makes the newest-20 window start with an `assistant` row.
describe('capHistory role parity', () => {
	const alternating = (n: number): ChatMessage[] =>
		Array.from({ length: n }, (_, i) => ({
			role: i % 2 === 0 ? 'user' : 'assistant',
			content: `m${i}`
		}));

	it('starts the capped window with a user turn for 21 alternating rows (assistant before the fix)', () => {
		const capped = capHistory(alternating(21));
		expect(capped.length).toBeLessThanOrEqual(HISTORY_LIMIT);
		expect(capped[0].role).toBe('user');
		expect(capped.at(-1)).toEqual({ role: 'user', content: 'm20' });
	});

	it('drops every leading non-user turn, not just the first', () => {
		const capped = capHistory(
			[
				{ role: 'assistant', content: 'a1' },
				{ role: 'assistant', content: 'a2' },
				{ role: 'user', content: 'u' }
			],
			3
		);
		expect(capped).toEqual([{ role: 'user', content: 'u' }]);
	});

	it('leaves a window that already starts with a user turn untouched', () => {
		const history = alternating(20);
		expect(capHistory(history)).toEqual(history);
	});
});
