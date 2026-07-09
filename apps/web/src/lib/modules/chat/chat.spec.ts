import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../db/client.ts';
import { createMockChatProvider, mockReplyFor } from './mock-provider.ts';
import type { ChatMessage, ChatProvider, ChatStreamOptions } from './provider.ts';
import { ipRateKey } from './rate-limit.ts';
import { chatMessages, chatRateLimits, chatSessions } from './schema.ts';
import { handleChatMessage, pruneChatSessions, type ChatDeps } from './service.ts';
import { signSessionToken } from './token.ts';
import { HISTORY_LIMIT } from './validate.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh). The provider is ALWAYS the mock here — no network, no key.
let db: Db;

const SECRET = 'chat-spec-secret';
const SYSTEM = 'test-system-prompt';

function deps(overrides: Partial<ChatDeps> = {}): ChatDeps {
	return {
		db,
		provider: createMockChatProvider(),
		secret: SECRET,
		systemPrompt: SYSTEM,
		...overrides
	};
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
	let out = '';
	for await (const chunk of iterable) out += chunk;
	return out;
}

/** Sends one message and fully consumes the reply (as the route would). */
async function roundTrip(
	input: { message: string; sessionToken?: string | null; ip?: string },
	d = deps()
) {
	const outcome = await handleChatMessage(d, {
		message: input.message,
		sessionToken: input.sessionToken ?? null,
		ip: input.ip ?? '198.51.100.1'
	});
	if (outcome.kind !== 'stream') return { outcome, reply: '' };
	return { outcome, reply: await collect(outcome.stream) };
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
});

afterAll(async () => {
	await db?.$client.end();
});

describe('handleChatMessage', () => {
	it('streams the mock reply and persists both messages', async () => {
		const { outcome, reply } = await roundTrip({ message: 'Cum pot dormi mai bine?' });
		expect(outcome.kind).toBe('stream');
		if (outcome.kind !== 'stream') return;

		expect(reply).toBe(mockReplyFor([{ role: 'user', content: 'Cum pot dormi mai bine?' }]));

		const stored = await db
			.select()
			.from(chatMessages)
			.where(eq(chatMessages.sessionId, outcome.sessionId))
			.orderBy(chatMessages.createdAt);
		expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(stored[0].content).toBe('Cum pot dormi mai bine?');
		expect(stored[1].content).toBe(reply);

		const [session] = await db
			.select()
			.from(chatSessions)
			.where(eq(chatSessions.id, outcome.sessionId));
		expect(session.messageCount).toBe(2);
	});

	it('continues the same session when the signed token is presented', async () => {
		const first = await roundTrip({ message: 'Salut!', ip: '198.51.100.2' });
		if (first.outcome.kind !== 'stream') throw new Error('expected stream');
		const second = await roundTrip({
			message: 'Am insomnie.',
			sessionToken: first.outcome.sessionToken,
			ip: '198.51.100.2'
		});
		if (second.outcome.kind !== 'stream') throw new Error('expected stream');

		expect(second.outcome.sessionId).toBe(first.outcome.sessionId);
		const stored = await db
			.select()
			.from(chatMessages)
			.where(eq(chatMessages.sessionId, first.outcome.sessionId));
		expect(stored).toHaveLength(4);
	});

	it('rejects a foreign (tampered/foreign-secret) session token with forbidden', async () => {
		const first = await roundTrip({ message: 'Salut!', ip: '198.51.100.3' });
		if (first.outcome.kind !== 'stream') throw new Error('expected stream');

		const foreign = signSessionToken('another-secret', first.outcome.sessionId, 'stolen-anon');
		const rejected = await handleChatMessage(deps(), {
			message: 'Salut!',
			sessionToken: foreign,
			ip: '198.51.100.3'
		});
		expect(rejected.kind).toBe('forbidden');

		// Nothing was persisted for the refused request.
		const stored = await db
			.select()
			.from(chatMessages)
			.where(eq(chatMessages.sessionId, first.outcome.sessionId));
		expect(stored).toHaveLength(2);
	});

	it('starts a fresh session when a validly-signed session was pruned', async () => {
		const token = signSessionToken(SECRET, 'no-such-session', 'no-such-anon');
		const { outcome } = await roundTrip({
			message: 'Salut!',
			sessionToken: token,
			ip: '198.51.100.4'
		});
		expect(outcome.kind).toBe('stream');
		if (outcome.kind !== 'stream') return;
		expect(outcome.sessionId).not.toBe('no-such-session');
	});

	it('rejects invalid messages without touching the db', async () => {
		const empty = await handleChatMessage(deps(), { message: '  ', sessionToken: null, ip: 'x' });
		expect(empty).toEqual({ kind: 'invalid', reason: 'empty' });
		const long = await handleChatMessage(deps(), {
			message: 'a'.repeat(2001),
			sessionToken: null,
			ip: 'x'
		});
		expect(long).toEqual({ kind: 'invalid', reason: 'too-long' });
		const notString = await handleChatMessage(deps(), { message: 7, sessionToken: null, ip: 'x' });
		expect(notString).toEqual({ kind: 'invalid', reason: 'invalid' });
	});

	it('caps the history sent to the provider at the last 20 messages', async () => {
		const seen: ChatMessage[][] = [];
		const mock = createMockChatProvider();
		const spying: ChatProvider = {
			kind: 'mock',
			stream(messages: ChatMessage[], options: ChatStreamOptions) {
				seen.push(messages);
				return mock.stream(messages, options);
			}
		};
		const d = deps({ provider: spying });

		let token: string | null = null;
		// 12 round trips create 24 stored messages (12 user + 12 assistant).
		for (let i = 0; i < 12; i++) {
			const { outcome } = await roundTrip(
				{ message: `mesaj ${i}`, sessionToken: token, ip: '198.51.100.5' },
				d
			);
			if (outcome.kind !== 'stream') throw new Error('expected stream');
			token = outcome.sessionToken;
		}

		const last = seen.at(-1)!;
		expect(last).toHaveLength(HISTORY_LIMIT);
		// The newest user message is included; the oldest turns fell off.
		expect(last.at(-1)).toEqual({ role: 'user', content: 'mesaj 11' });
		expect(last.some((m) => m.content === 'mesaj 0')).toBe(false);
	});

	it('passes the persona system prompt to the provider', async () => {
		let seenSystem = '';
		const mock = createMockChatProvider();
		const spying: ChatProvider = {
			kind: 'mock',
			stream(messages: ChatMessage[], options: ChatStreamOptions) {
				seenSystem = options.system;
				return mock.stream(messages, options);
			}
		};
		await roundTrip({ message: 'Salut!', ip: '198.51.100.6' }, deps({ provider: spying }));
		expect(seenSystem).toBe(SYSTEM);
	});

	it('returns 429 semantics on the 21st message in the window (per session)', async () => {
		let token: string | null = null;
		for (let i = 0; i < 20; i++) {
			const { outcome } = await roundTrip({
				message: `mesaj ${i}`,
				sessionToken: token,
				ip: `203.0.113.${i}` // vary the IP so only the SESSION counter can trip
			});
			if (outcome.kind !== 'stream') throw new Error(`message ${i} unexpectedly ${outcome.kind}`);
			token = outcome.sessionToken;
		}

		const blocked = await handleChatMessage(deps(), {
			message: 'mesajul 21',
			sessionToken: token,
			ip: '203.0.113.99'
		});
		expect(blocked.kind).toBe('rate-limited');

		// After the sliding window fully expires (two aligned windows — the
		// previous hour's count decays over the following one) the same session
		// may talk again.
		const later = () => new Date(Date.now() + 121 * 60 * 1000);
		const resumed = await handleChatMessage(deps({ now: later }), {
			message: 'după fereastră',
			sessionToken: token,
			ip: '203.0.113.99'
		});
		expect(resumed.kind).toBe('stream');
		if (resumed.kind === 'stream') await collect(resumed.stream);
	});

	it('rate limits by IP across different sessions', async () => {
		const ip = '192.0.2.77';
		for (let i = 0; i < 20; i++) {
			// No token: every message opens a brand-new session on the same IP.
			const { outcome } = await roundTrip({ message: `mesaj ${i}`, ip });
			if (outcome.kind !== 'stream') throw new Error(`message ${i} unexpectedly ${outcome.kind}`);
		}
		const blocked = await handleChatMessage(deps(), {
			message: 'mesajul 21',
			sessionToken: null,
			ip
		});
		expect(blocked.kind).toBe('rate-limited');
	});

	it('never over-admits under a parallel burst (atomic IP counter, regression for audit resilience #5)', async () => {
		// Fixed, window-aligned time so the burst can't straddle a window boundary.
		const NOW = new Date('2026-03-02T10:00:00Z');
		const d = deps({ now: () => NOW });
		const ip = '198.51.100.200';

		// 25 concurrent messages, each from a fresh session: only the IP counter
		// can trip. The pre-fix read-modify-write code admits all 25.
		const results = await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				handleChatMessage(d, { message: `cursă ${i}`, sessionToken: null, ip })
			)
		);
		expect(results.filter((r) => r.kind === 'stream')).toHaveLength(20);
		expect(results.filter((r) => r.kind === 'rate-limited')).toHaveLength(5);

		// The counter reached exactly 25 — no lost increments.
		const [row] = await db
			.select()
			.from(chatRateLimits)
			.where(eq(chatRateLimits.key, ipRateKey(ip)));
		expect(row.count).toBe(25);
	});
});

describe('pruneChatSessions', () => {
	it('deletes sessions older than 30 days, cascading their messages', async () => {
		const { outcome, reply } = await roundTrip({ message: 'Salut!', ip: '198.51.100.7' });
		if (outcome.kind !== 'stream') throw new Error('expected stream');
		expect(reply).not.toBe('');

		// Age one session artificially; leave the rest untouched.
		await db
			.update(chatSessions)
			.set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
			.where(eq(chatSessions.id, outcome.sessionId));

		const deleted = await pruneChatSessions(db);
		expect(deleted).toBe(1);

		const rows = await db
			.select()
			.from(chatMessages)
			.where(eq(chatMessages.sessionId, outcome.sessionId));
		expect(rows).toHaveLength(0);

		// Recent sessions survive.
		const remaining = await db.select().from(chatSessions);
		expect(remaining.length).toBeGreaterThan(0);
	});
});
