import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ANTHROPIC_MAX_RETRIES,
	ANTHROPIC_TIMEOUT_MS_DEFAULT,
	createAnthropicChatProvider
} from './anthropic-provider.ts';
import { createMockChatProvider, mockReplyFor } from './mock-provider.ts';
import type { ChatStreamEvent } from './provider.ts';
import { selectChatProvider } from './select.ts';

async function events(iterable: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
	const out: ChatStreamEvent[] = [];
	for await (const event of iterable) out.push(event);
	return out;
}

async function collect(iterable: AsyncIterable<ChatStreamEvent>): Promise<string> {
	return (await events(iterable)).map((e) => ('delta' in e ? e.delta : '')).join('');
}

/** A Messages API SSE body: one text block, then the given stop reason. */
function sseBody(text: string, stopReason: string): string {
	const frames = [
		{
			type: 'message_start',
			message: {
				id: 'msg_test',
				type: 'message',
				role: 'assistant',
				model: 'claude-sonnet-5',
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 }
			}
		},
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		...(text
			? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]
			: []),
		{ type: 'content_block_stop', index: 0 },
		{
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 5 }
		},
		{ type: 'message_stop' }
	];
	return frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
}

const sseHeaders = { 'content-type': 'text/event-stream' };

/** Fake fetch answering a canned SSE body; records the request JSON. */
function sseFetch(body: string, status = 200) {
	const requests: Record<string, unknown>[] = [];
	const fetchFn = (async (_url: unknown, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response(body, { status, headers: sseHeaders });
	}) as typeof fetch;
	return { fetchFn, requests };
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

	it('stops streaming when the abort signal fires (client disconnected)', async () => {
		const provider = createMockChatProvider();
		const abort = new AbortController();
		const chunks: string[] = [];
		for await (const chunk of provider.stream([{ role: 'user', content: 'Salut!' }], {
			system: 's',
			maxTokens: 10,
			signal: abort.signal
		})) {
			chunks.push(chunk);
			abort.abort();
		}
		expect(chunks).toHaveLength(1);
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

	// Audit Theme C (resilience #3/#4): calls must be bounded and abortable.
	// The fake fetch never completes but honors its abort signal — exactly
	// what a hung Anthropic socket looks like to the SDK.
	const hangingFetch = ((_url: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
		})) as typeof fetch;

	it('times out instead of hanging when the API never responds (hung before the fix)', async () => {
		const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
			timeoutMs: 50,
			maxRetries: 0,
			fetchFn: hangingFetch
		});
		await expect(
			collect(provider.stream([{ role: 'user', content: 'x' }], { system: 's', maxTokens: 10 }))
		).rejects.toThrow(/timed out|timeout|abort/i);
	}, 3_000);

	it('aborts the upstream request when the stream signal fires (client disconnected)', async () => {
		const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
			timeoutMs: 60_000,
			maxRetries: 0,
			fetchFn: hangingFetch
		});
		const abort = new AbortController();
		const pending = collect(
			provider.stream([{ role: 'user', content: 'x' }], {
				system: 's',
				maxTokens: 10,
				signal: abort.signal
			})
		);
		setTimeout(() => abort.abort(), 20);
		await expect(pending).rejects.toThrow(/abort/i);
	}, 3_000);

	// FIX-14 (audit 2026-09-03 "Chat"): the call was misconfigured for this
	// workload — adaptive thinking ate the 1024-token cap, stop_reason was
	// never read, SDK errors vanished without a log line, and the SDK's
	// 60 s × 3 attempts budget did not fit the route's maxDuration.
	describe('provider configuration (FIX-14)', () => {
		afterEach(() => vi.restoreAllMocks());

		const ask = (provider: ReturnType<typeof createAnthropicChatProvider>, maxTokens = 2048) =>
			provider.stream([{ role: 'user', content: 'Salut' }], { system: 's', maxTokens });

		it('sends thinking disabled and the caller max_tokens', async () => {
			const { fetchFn, requests } = sseFetch(sseBody('Salut!', 'end_turn'));
			const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
				maxRetries: 0,
				fetchFn
			});
			expect(await events(ask(provider, 2048))).toEqual([{ delta: 'Salut!' }]);
			expect(requests[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 2048 });
		});

		it('maps a max_tokens stop into a stop event after the deltas', async () => {
			const { fetchFn } = sseFetch(sseBody('Un răspuns tă', 'max_tokens'));
			const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
				maxRetries: 0,
				fetchFn
			});
			expect(await events(ask(provider))).toEqual([
				{ delta: 'Un răspuns tă' },
				{ stop: 'max_tokens' }
			]);
		});

		it('maps a refusal into a stop event even with no text', async () => {
			const { fetchFn } = sseFetch(sseBody('', 'refusal'));
			const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
				maxRetries: 0,
				fetchFn
			});
			expect(await events(ask(provider))).toEqual([{ stop: 'refusal' }]);
		});

		it('logs a caught SDK error with class + status and rethrows (swallowed before the fix)', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const fetchFn = (async () =>
				new Response(
					JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
					{ status: 429, headers: { 'content-type': 'application/json' } }
				)) as typeof fetch;
			const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
				maxRetries: 0,
				fetchFn
			});
			await expect(collect(ask(provider))).rejects.toThrow(/429|rate/i);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			const line = String(errorSpy.mock.calls[0][0]);
			const entry = JSON.parse(line) as Record<string, unknown>;
			expect(entry.level).toBe('error');
			expect(entry.status).toBe(429);
			expect(entry.path).toBe('/api/chat');
			expect(String(entry.message)).toMatch(/RateLimitError/);
		});

		it('aborts a stream that goes silent (inactivity timeout) instead of hanging', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const encoder = new TextEncoder();
			// message_start arrives, then the socket stays open and silent.
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sseBody('', 'end_turn').split('\n\n')[0] + '\n\n'));
				}
			});
			const fetchFn = (async () => new Response(body, { status: 200, headers: sseHeaders })) as typeof fetch;
			const provider = createAnthropicChatProvider('sk-ant-test-not-real', {
				maxRetries: 0,
				inactivityMs: 50,
				fetchFn
			});
			await expect(collect(ask(provider))).rejects.toThrow(/inactiv/i);
		}, 3_000);

		it('keeps the worst-case SDK budget under the route maxDuration (60 s)', () => {
			expect(ANTHROPIC_MAX_RETRIES).toBe(1);
			expect(ANTHROPIC_TIMEOUT_MS_DEFAULT * (ANTHROPIC_MAX_RETRIES + 1)).toBeLessThan(60_000);
		});
	});
});
