import { randomUUID } from 'node:crypto';
import { desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
	consumeRateLimit,
	pruneStaleRateLimits,
	type RateLimitConfig
} from '../../server/rate-limit/core.ts';
import type { ChatMessage, ChatProvider, ChatStreamEvent } from './provider.ts';
import { CHAT_RATE_LIMIT, ipRateKey, sessionRateKey } from './rate-limit.ts';
import { chatMessages, chatRateLimits, chatSessions, type ChatSessionRow } from './schema.ts';
import { signSessionToken, verifySessionToken } from './token.ts';
import { capHistory, HISTORY_LIMIT, validateChatMessage } from './validate.ts';

/**
 * Output cap sent to the provider per assistant reply. Sized for the advice
 * persona (a few short paragraphs of Romanian, which tokenizes at roughly
 * 3 chars/token) with thinking disabled, so every token is visible text —
 * see the chat README "Provider settings" (FIX-14).
 */
export const CHAT_MAX_TOKENS = 2048;

export const CHAT_RETENTION_DAYS = 30;

/**
 * Framework-free chat service: the /api/chat route is thin glue around
 * `handleChatMessage`, so the whole flow (session ownership, rate limiting,
 * persistence, streaming) is integration-testable without a server.
 */
export interface ChatDeps {
	db: Db;
	provider: ChatProvider;
	/** HMAC secret for the session cookie token. */
	secret: string;
	/** Persona system prompt for the active site. */
	systemPrompt: string;
	rateConfig?: RateLimitConfig;
	now?: () => Date;
}

export interface ChatInput {
	message: unknown;
	/** Raw cookie value, if the visitor already has one. */
	sessionToken: string | null;
	ip: string;
	/**
	 * Fired when the client disconnects mid-reply (the SSE stream's cancel).
	 * Threaded into the provider so the upstream call aborts, and the
	 * assistant message is NOT persisted for a reply nobody received.
	 */
	signal?: AbortSignal;
}

export type ChatOutcome =
	| {
			kind: 'stream';
			/**
			 * Assistant reply events. The assistant message is persisted only
			 * after the iterable is fully consumed AND the reply ended normally
			 * (a truncated or declined reply — a `stop` event — is not stored).
			 */
			stream: AsyncIterable<ChatStreamEvent>;
			sessionId: string;
			/** Signed cookie value to (re)set on the response. */
			sessionToken: string;
	  }
	| { kind: 'invalid'; reason: 'invalid' | 'empty' | 'too-long' }
	| { kind: 'forbidden' }
	| { kind: 'rate-limited' };

async function createSession(db: Db): Promise<ChatSessionRow> {
	const [row] = await db
		.insert(chatSessions)
		.values({ id: randomUUID(), anonymousToken: randomUUID() })
		.returning();
	return row;
}

/**
 * Resolve the visitor's session from the signed cookie token. A tampered or
 * foreign token is refused; a valid token whose session was pruned starts a
 * fresh conversation instead of erroring.
 */
async function resolveSession(
	db: Db,
	secret: string,
	sessionToken: string | null
): Promise<ChatSessionRow | 'forbidden'> {
	if (!sessionToken) return createSession(db);
	const verified = verifySessionToken(secret, sessionToken);
	if (!verified.ok) return 'forbidden';
	const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, verified.sessionId));
	if (!row) return createSession(db);
	if (row.anonymousToken !== verified.anonymousToken) return 'forbidden';
	return row;
}

export async function handleChatMessage(deps: ChatDeps, input: ChatInput): Promise<ChatOutcome> {
	const { db, provider, secret, systemPrompt } = deps;
	const rateConfig = deps.rateConfig ?? CHAT_RATE_LIMIT;
	const now = deps.now?.() ?? new Date();

	const validated = validateChatMessage(input.message);
	if (!validated.ok) return { kind: 'invalid', reason: validated.reason };

	const resolved = await resolveSession(db, secret, input.sessionToken);
	if (resolved === 'forbidden') return { kind: 'forbidden' };
	const session = resolved;

	// Both counters are consumed atomically BEFORE anything is persisted; the
	// decision comes from the post-increment counts, so a concurrent burst
	// cannot slip past the cap. A refused message still consumes its slots.
	const consumed = await Promise.all(
		[sessionRateKey(session.id), ipRateKey(input.ip)].map((key) =>
			consumeRateLimit(db, chatRateLimits, key, rateConfig, now)
		)
	);
	if (consumed.some((result) => result.limited)) return { kind: 'rate-limited' };

	// Deliberately not transactional (audit Theme B): the assistant reply is
	// persisted only after the external stream completes, which could never sit
	// inside a DB transaction. A failure mid-stream leaves a user message with
	// no reply — an accurate record, not corruption. `messageCount` is a
	// heuristic pruning stat, not an invariant.
	await db
		.insert(chatMessages)
		.values({ id: randomUUID(), sessionId: session.id, role: 'user', content: validated.message });
	await bumpMessageCount(db, session.id);

	// History (including the message just stored): the newest HISTORY_LIMIT
	// rows read in one bounded query (as `getChatHistory` does), flipped back
	// to chronological order, then role-aligned for the provider.
	const rows = await db
		.select({ role: chatMessages.role, content: chatMessages.content })
		.from(chatMessages)
		.where(eq(chatMessages.sessionId, session.id))
		.orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
		.limit(HISTORY_LIMIT);
	const history = capHistory((rows as ChatMessage[]).reverse());

	async function* respond(): AsyncIterable<ChatStreamEvent> {
		let full = '';
		let stopped = false;
		for await (const event of provider.stream(history, {
			system: systemPrompt,
			maxTokens: CHAT_MAX_TOKENS,
			signal: input.signal
		})) {
			if ('delta' in event) full += event.delta;
			else stopped = true;
			yield event;
		}
		// Client disconnected mid-reply: the user message stays (accurate), but
		// a reply nobody received must not be persisted as if it were. Same
		// for a truncated/declined reply (FIX-14): the widget shows it as such
		// with a retry, and the history must not carry it as an answer.
		if (input.signal?.aborted || stopped) return;
		await db
			.insert(chatMessages)
			.values({ id: randomUUID(), sessionId: session.id, role: 'assistant', content: full });
		await bumpMessageCount(db, session.id);
	}

	return {
		kind: 'stream',
		stream: respond(),
		sessionId: session.id,
		sessionToken: signSessionToken(secret, session.id, session.anonymousToken)
	};
}

/** Most messages a history restore returns to the widget (newest win). */
export const HISTORY_RESTORE_LIMIT = 50;

export interface ChatHistoryDeps {
	db: Db;
	/** HMAC secret for the session cookie token. */
	secret: string;
	rateConfig?: RateLimitConfig;
	now?: () => Date;
}

export type ChatHistoryOutcome =
	| { kind: 'history'; sessionId: string; messages: ChatMessage[] }
	/** No cookie, or a validly-signed token whose session was pruned. */
	| { kind: 'none' }
	| { kind: 'forbidden' }
	| { kind: 'rate-limited' };

/** Rate-limit keys for history restores — separate from the send keys so a
 * page reload never consumes the visitor's message budget. */
export function historySessionRateKey(sessionId: string): string {
	return `history:session:${sessionId}`;
}

export function historyIpRateKey(ip: string): string {
	return `history:ip:${ip}`;
}

/**
 * Restore the stored conversation for the session the signed cookie proves
 * ownership of — the token is the ONLY authorization. Mirrors the POST path's
 * rules: tampered/foreign tokens are refused, a pruned session yields nothing
 * (retention wins), the same sliding-window limiter applies (on `history:`
 * keys), and the returned list is bounded to the newest messages in
 * chronological order.
 */
export async function getChatHistory(
	deps: ChatHistoryDeps,
	input: { sessionToken: string | null; ip: string; limit?: number }
): Promise<ChatHistoryOutcome> {
	const { db, secret } = deps;
	// A visitor without a cookie has nothing to restore — free, no DB touch.
	if (!input.sessionToken) return { kind: 'none' };

	const verified = verifySessionToken(secret, input.sessionToken);
	if (!verified.ok) return { kind: 'forbidden' };

	const [session] = await db
		.select()
		.from(chatSessions)
		.where(eq(chatSessions.id, verified.sessionId));
	if (!session) return { kind: 'none' };
	if (session.anonymousToken !== verified.anonymousToken) return { kind: 'forbidden' };

	const rateConfig = deps.rateConfig ?? CHAT_RATE_LIMIT;
	const now = deps.now?.() ?? new Date();
	const consumed = await Promise.all(
		[historySessionRateKey(session.id), historyIpRateKey(input.ip)].map((key) =>
			consumeRateLimit(db, chatRateLimits, key, rateConfig, now)
		)
	);
	if (consumed.some((result) => result.limited)) return { kind: 'rate-limited' };

	// Newest N, then flipped back to chronological order for display.
	const limit = input.limit ?? HISTORY_RESTORE_LIMIT;
	const rows = await db
		.select({ role: chatMessages.role, content: chatMessages.content })
		.from(chatMessages)
		.where(eq(chatMessages.sessionId, session.id))
		.orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
		.limit(limit);
	return { kind: 'history', sessionId: session.id, messages: (rows as ChatMessage[]).reverse() };
}

async function bumpMessageCount(db: Db, sessionId: string): Promise<void> {
	await db
		.update(chatSessions)
		.set({ messageCount: sql`${chatSessions.messageCount} + 1` })
		.where(eq(chatSessions.id, sessionId));
}

/**
 * Delete sessions older than the retention window (messages cascade), plus
 * expired rate-limit counters — `session:`/`ip:` keys are upserted per key and
 * never removed by the limiter, so without this sweep `chat_rate_limits`
 * grows unbounded (audit resilience #6).
 */
export async function pruneChatSessions(
	db: Db,
	now: Date = new Date(),
	retentionDays: number = CHAT_RETENTION_DAYS
): Promise<{ sessions: number; rateLimitRows: number }> {
	const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
	const deleted = await db
		.delete(chatSessions)
		.where(lt(chatSessions.createdAt, cutoff))
		.returning({ id: chatSessions.id });
	const rateLimitRows = await pruneStaleRateLimits(db, chatRateLimits, cutoff);
	return { sessions: deleted.length, rateLimitRows };
}
