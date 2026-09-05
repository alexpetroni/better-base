# Chat module

Assistant chat behind a `ChatProvider` interface (Phase 6). `mock` is the default
everywhere (dev, vitest, e2e); `anthropic` is opt-in via `CHAT_PROVIDER=anthropic` +
`ANTHROPIC_API_KEY` and fails at boot without the key (`select.ts`, `server.ts`).

## Stream contract

`ChatProvider.stream()` yields `ChatStreamEvent`s: `{ delta }` text chunks, then at most
one terminal `{ stop: 'max_tokens' | 'refusal' }`. A normal end yields no stop event.
`chatSseStream` frames them 1:1 and ends the response with exactly one terminal frame:
`{ done: true }`, `{ stop }`, or `{ error }`. The panel treats a stream that closes with no
terminal frame as a broken reply (failed bubble + retry); a `stop` renders as a truncated
or declined bubble with the same retry. The service persists the assistant message only
when the reply ended normally — a truncated/declined reply is not stored as an answer.

## History window

`capHistory` keeps the newest `HISTORY_LIMIT` (20) rows and then drops every leading
non-`user` turn: the Messages API rejects a conversation whose first turn is `assistant`,
and a newest-20 window over alternating turns starts with one every other message.
The service reads history with `ORDER BY created_at DESC, id DESC LIMIT 20` and reverses,
as `getChatHistory` does, instead of loading the whole conversation per message.

## Provider settings (Anthropic) and why — FIX-14

| Setting       | Value                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`       | `claude-sonnet-5`                        | Quality/latency balance for short advice replies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `thinking`    | `{ type: 'disabled' }`                   | On this model, omitting `thinking` runs adaptive thinking, whose tokens count against `max_tokens` — a 1024 cap could be spent before a single visible word. The persona answers short, well-bounded lifestyle questions in a streaming UI where time-to-first-token is what the visitor feels; a thinking budget buys nothing here and made replies both slower and randomly truncated. `output_config: { effort: 'low' }` was the alternative; disabling is chosen because it makes the output budget deterministic (every token is visible text) rather than merely smaller. |
| `max_tokens`  | `CHAT_MAX_TOKENS = 2048`                 | A few short paragraphs of Romanian (≈3 chars/token) with the disclaimer; with thinking disabled this is all visible text, and a persona reply that needs more is a `max_tokens` stop the panel shows as truncated.                                                                                                                                                                                                                                                                                                                                                              |
| `stop_reason` | read from `message_delta`                | `max_tokens` and `refusal` become a `{ stop }` event → SSE frame; before, truncated/empty replies streamed as `done` and were persisted as answers.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `timeout`     | `ANTHROPIC_TIMEOUT_MS` = 20 s            | Time to response headers per attempt (the SDK does not cut a healthy stream).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `maxRetries`  | `1`                                      | Worst case 2 × 20 s = 40 s to first byte, under the route's `maxDuration = 60`; the old 60 s × 3 attempts could not finish inside it.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| inactivity    | `ANTHROPIC_INACTIVITY_MS_DEFAULT` = 15 s | A stream that emits nothing for 15 s is dead; abort it (error frame) instead of holding the request until the platform kills it with no frame sent.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| errors        | `console.error(formatServerError(…))`    | One JSON line per failed call with the SDK error class (`RateLimitError`, `AuthenticationError`, …) and the upstream status; the visitor still gets the generic error frame.                                                                                                                                                                                                                                                                                                                                                                                                    |

The `fetchFn` option is a test seam only: `provider.spec.ts` drives the SDK through canned
SSE bodies and error responses; no test may instantiate the provider with a real key.

## Abuse bounds

`handleChatMessage` consumes the IP counter before resolving the session, so a cookieless
caller past the cap creates no session row. The session counter is consumed after the
session is resolved. `pruneChatSessions` deletes in batches of `PRUNE_BATCH_SIZE` (5000)
so the daily sweep never runs one statement past `statement_timeout`.

## Observability

The server barrel logs `chat provider: <kind>` once at boot and `/api/health` carries the
kind as `chatProvider`; `pnpm launch:check` fails a live env (`EMAIL_DRYRUN=false`) that is
still on a mock chat or courier provider unless `--allow-mock-providers` is passed.
