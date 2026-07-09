import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicChatProvider } from './anthropic-provider.ts';
import { createMockChatProvider, mockReplyFor } from './mock-provider.ts';
import { selectChatProvider } from './select.ts';

async function collect(iterable: AsyncIterable<string>): Promise<string> {
	let out = '';
	for await (const chunk of iterable) out += chunk;
	return out;
}

describe('selectChatProvider', () => {
	it('defaults to mock when CHAT_PROVIDER is unset or empty', () => {
		expect(selectChatProvider({})).toEqual({ kind: 'mock' });
		expect(selectChatProvider({ CHAT_PROVIDER: '' })).toEqual({ kind: 'mock' });
		expect(selectChatProvider({ CHAT_PROVIDER: '  ' })).toEqual({ kind: 'mock' });
	});

	it('stays on mock even when a key is present but CHAT_PROVIDER is not anthropic', () => {
		// A leaked/ambient key alone must never activate the live provider.
		expect(selectChatProvider({ ANTHROPIC_API_KEY: 'sk-ant-something' })).toEqual({
			kind: 'mock'
		});
	});

	it('selects anthropic only with CHAT_PROVIDER=anthropic AND a key', () => {
		expect(
			selectChatProvider({ CHAT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' })
		).toEqual({ kind: 'anthropic', apiKey: 'sk-ant-test' });
	});

	it('fails fast when anthropic is requested without a key', () => {
		expect(() => selectChatProvider({ CHAT_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
		expect(() =>
			selectChatProvider({ CHAT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' })
		).toThrow(/ANTHROPIC_API_KEY/);
	});

	it('rejects unknown provider names', () => {
		expect(() => selectChatProvider({ CHAT_PROVIDER: 'openai' })).toThrow(/Unknown CHAT_PROVIDER/);
	});
});

describe('MockChatProvider', () => {
	afterEach(() => vi.restoreAllMocks());

	it('streams a deterministic ro answer without any network attempt', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('network attempted in a test'));

		const provider = createMockChatProvider();
		const messages = [{ role: 'user' as const, content: 'Cum pot dormi mai bine?' }];
		const first = await collect(provider.stream(messages, { system: 's', maxTokens: 10 }));
		const second = await collect(provider.stream(messages, { system: 's', maxTokens: 10 }));

		expect(first).toBe(second);
		expect(first).toBe(mockReplyFor(messages));
		expect(first).toMatch(/somn/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('answers by keyword and falls back to a generic ro reply', () => {
		expect(mockReplyFor([{ role: 'user', content: 'Salut!' }])).toMatch(/Salut/);
		expect(mockReplyFor([{ role: 'user', content: 'Am insomnie de o lună' }])).toMatch(
			/culcă-te|somn/i
		);
		expect(mockReplyFor([{ role: 'user', content: 'Vreau un test' }])).toMatch(/chestionar/i);
		expect(mockReplyFor([{ role: 'user', content: 'xyzzy' }])).toMatch(/nu ofer sfaturi medicale/i);
	});

	it('keeps the medical disclaimer stance in canned health answers', () => {
		expect(mockReplyFor([{ role: 'user', content: 'insomnie' }])).toMatch(/medic/i);
	});
});

describe('AnthropicChatProvider', () => {
	it('refuses construction without a key (no silent env fallback)', () => {
		expect(() => createAnthropicChatProvider('')).toThrow(/API key/);
	});

	it('constructs with an explicit key without any network attempt', () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('network attempted in a test'));
		const provider = createAnthropicChatProvider('sk-ant-test-not-real');
		expect(provider.kind).toBe('anthropic');
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});
