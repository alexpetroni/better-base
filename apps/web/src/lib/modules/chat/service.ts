import { randomUUID } from 'node:crypto';
import { asc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { consumeRateLimit, type RateLimitConfig } from '../../server/rate-limit/core.ts';
import type { ChatMessage, ChatProvider } from './provider.ts';
import { CHAT_RATE_LIMIT, ipRateKey, sessionRateKey } from './rate-limit.ts';
import { chatMessages, chatRateLimits, chatSessions, type ChatSessionRow } from './schema.ts';
import { signSessionToken, verifySessionToken } from './token.ts';
import { capHistory, validateChatMessage } from './validate.ts';

/** Output cap sent to the provider per assistant reply. */
export const CHAT_MAX_TOKENS = 1024;

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
}

export type ChatOutcome =
	| {
			kind: 'stream';
			/**
			 * Assistant reply chunks. The assistant message is persisted only
			 * after the iterable is fully consumed.
			 */
			stream: AsyncIterable<string>;
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

	// History (including the message just stored), capped for the provider.
	const rows = await db
		.select({ role: chatMessages.role, content: chatMessages.content })
		.from(chatMessages)
		.where(eq(chatMessages.sessionId, session.id))
		.orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
	const history = capHistory(rows as ChatMessage[]);

	async function* respond(): AsyncIterable<string> {
		let full = '';
		for await (const chunk of provider.stream(history, {
			system: systemPrompt,
			maxTokens: CHAT_MAX_TOKENS
		})) {
			full += chunk;
			yield chunk;
		}
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

async function bumpMessageCount(db: Db, sessionId: string): Promise<void> {
	await db
		.update(chatSessions)
		.set({ messageCount: sql`${chatSessions.messageCount} + 1` })
		.where(eq(chatSessions.id, sessionId));
}

/** Delete sessions older than the retention window (messages cascade). */
export async function pruneChatSessions(
	db: Db,
	now: Date = new Date(),
	retentionDays: number = CHAT_RETENTION_DAYS
): Promise<number> {
	const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
	const deleted = await db
		.delete(chatSessions)
		.where(lt(chatSessions.createdAt, cutoff))
		.returning({ id: chatSessions.id });
	return deleted.length;
}
