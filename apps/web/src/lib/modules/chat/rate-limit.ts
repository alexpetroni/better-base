import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { chatRateLimits } from './schema.ts';

/** 20 user messages per hour, per session AND per IP (fixed window). */
export const CHAT_RATE_LIMIT = { maxMessages: 20, windowMs: 60 * 60 * 1000 } as const;

export interface ChatRateConfig {
	maxMessages: number;
	windowMs: number;
}

export interface ChatRateState {
	count: number;
	windowStartedAt: Date;
}

export function sessionRateKey(sessionId: string): string {
	return `session:${sessionId}`;
}

export function ipRateKey(ip: string): string {
	return `ip:${ip}`;
}

/** Pure: is a new message blocked given the recorded counter state? */
export function isChatRateLimited(
	state: ChatRateState | null,
	now: Date,
	config: ChatRateConfig = CHAT_RATE_LIMIT
): boolean {
	if (!state) return false;
	if (now.getTime() - state.windowStartedAt.getTime() >= config.windowMs) return false;
	return state.count >= config.maxMessages;
}

/** Pure: next state after an accepted message (fixed window, resets on expiry). */
export function recordChatMessage(
	state: ChatRateState | null,
	now: Date,
	config: ChatRateConfig = CHAT_RATE_LIMIT
): ChatRateState {
	if (!state || now.getTime() - state.windowStartedAt.getTime() >= config.windowMs) {
		return { count: 1, windowStartedAt: now };
	}
	return { count: state.count + 1, windowStartedAt: state.windowStartedAt };
}

export async function getChatRateState(db: Db, key: string): Promise<ChatRateState | null> {
	const [row] = await db
		.select({ count: chatRateLimits.count, windowStartedAt: chatRateLimits.windowStartedAt })
		.from(chatRateLimits)
		.where(eq(chatRateLimits.key, key));
	return row ?? null;
}

export async function saveChatRateState(db: Db, key: string, state: ChatRateState): Promise<void> {
	await db
		.insert(chatRateLimits)
		.values({ key, count: state.count, windowStartedAt: state.windowStartedAt })
		.onConflictDoUpdate({
			target: chatRateLimits.key,
			set: { count: state.count, windowStartedAt: state.windowStartedAt }
		});
}
