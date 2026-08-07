import { json } from '@sveltejs/kit';
import { resolvePersona } from '$lib/config/personas';
import { getDb } from '$lib/db';
import {
	CHAT_ERRORS,
	CHAT_SESSION_COOKIE,
	chatSseStream,
	getChatHistory,
	getChatProvider,
	getChatSecret,
	handleChatMessage
} from '$lib/modules/chat/server';
import { readJsonBounded } from '$lib/server/body';
import { getSite } from '$lib/server/site';
import type { RequestHandler } from './$types';

const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // matches the 30-day retention

// Generous for a ≤2000-char message even fully \uXXXX-escaped, tiny for abuse.
const CHAT_MAX_BODY_BYTES = 32 * 1024;

/**
 * Serverless (adapter-vercel) only; ignored by adapter-node. A streamed reply
 * outlives the 10s default of the Hobby plan, and the runtime must stay Node —
 * this route reaches node:crypto and the Postgres driver.
 */
export const config = { maxDuration: 60 };

/**
 * Advice chat endpoint: accepts `{ message }`, streams the assistant reply as
 * SSE (`data: {"delta": …}` frames, then `data: {"done": true}`). Session
 * ownership rides in a signed httpOnly cookie; all errors are JSON with a
 * ro message the widget renders verbatim.
 */
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const parsed = await readJsonBounded(request, CHAT_MAX_BODY_BYTES);
	if (!parsed.ok) {
		return json(
			{ error: CHAT_ERRORS.invalid },
			{ status: parsed.reason === 'too-large' ? 413 : 400 }
		);
	}
	const body = parsed.value;

	const site = getSite();
	const persona = resolvePersona(site.chatPersonaKey);
	// Aborted by the SSE stream's cancel() when the client disconnects — the
	// service threads it to the provider and skips the assistant DB write.
	const abort = new AbortController();
	const outcome = await handleChatMessage(
		{
			db: getDb(),
			provider: getChatProvider(),
			secret: getChatSecret(),
			systemPrompt: persona.systemPrompt({ siteName: site.name })
		},
		{
			message: (body as { message?: unknown } | null)?.message,
			sessionToken: cookies.get(CHAT_SESSION_COOKIE) ?? null,
			ip: getClientAddress(),
			signal: abort.signal
		}
	);

	switch (outcome.kind) {
		case 'invalid':
			return json({ error: CHAT_ERRORS[outcome.reason] }, { status: 400 });
		case 'forbidden':
			return json({ error: CHAT_ERRORS.forbidden }, { status: 403 });
		case 'rate-limited':
			return json({ error: CHAT_ERRORS.rateLimited }, { status: 429 });
	}

	cookies.set(CHAT_SESSION_COOKIE, outcome.sessionToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SESSION_COOKIE_MAX_AGE
	});

	return new Response(chatSseStream(outcome.stream, abort), {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};

/**
 * History restore: the stored conversation for the session the signed cookie
 * proves ownership of, oldest first, bounded. No cookie or a pruned session →
 * an empty list; a tampered/foreign token → 403 (the token is the only
 * authorization). The widget calls this once on mount and treats every
 * non-200 as "nothing to restore".
 */
export const GET: RequestHandler = async ({ cookies, getClientAddress }) => {
	const outcome = await getChatHistory(
		{ db: getDb(), secret: getChatSecret() },
		{ sessionToken: cookies.get(CHAT_SESSION_COOKIE) ?? null, ip: getClientAddress() }
	);
	switch (outcome.kind) {
		case 'forbidden':
			return json({ error: CHAT_ERRORS.forbidden }, { status: 403 });
		case 'rate-limited':
			return json({ error: CHAT_ERRORS.rateLimited }, { status: 429 });
		case 'none':
			return json({ messages: [] });
		case 'history':
			return json({ messages: outcome.messages });
	}
};

/** "New conversation": forget the session cookie (rows expire via pruning). */
export const DELETE: RequestHandler = ({ cookies }) => {
	cookies.delete(CHAT_SESSION_COOKIE, { path: '/' });
	return json({ ok: true });
};
