# Phase 6 — Chat: pillar-persona assistant

## Objective

A site-embedded advice chat with a provider abstraction (mock for dev/tests,
Anthropic for prod), persona and guardrails driven by site config, streaming
responses, and abuse protection.

## Deliverables

1. **`modules/chat` provider interface**: `ChatProvider.stream(messages,
   { system, maxTokens }) → AsyncIterable<string>`. Implementations:
   `MockChatProvider` (deterministic, keyword-based canned ro answers — enough
   to demo the funnel) and `AnthropicChatProvider` (model `claude-sonnet-5`,
   streaming). Selection: `CHAT_PROVIDER` env (`mock` default; `anthropic`
   requires `ANTHROPIC_API_KEY` at boot or fail fast).
2. **Personas**: `src/lib/config/personas/{sleep-coach,life-coach}.ts` — system
   prompts (ro) keyed by the site config's `chatPersonaKey`. Persona must
   include: scope (advice within the site's active pillars), a firm "not
   medical advice — see a doctor for medical concerns" stance, refusal style
   for off-topic requests, and instruction to suggest relevant site quizzes.
3. **Schema**: `chat_sessions` — id, anonymous_token, created_at, message_count;
   `chat_messages` — session_id, role, content, created_at. Retention: a
   `pnpm chat:prune` script deletes sessions older than 30 days (wire into
   docs, cron comes at deploy time).
4. **API**: `POST /api/chat` — SSE/stream response; validates message length
   (≤ 2000 chars), session ownership by signed cookie token. History capped
   (last 20 messages sent to provider).
5. **Rate limiting**: per-session and per-IP (e.g. 20 messages/hour, in-DB
   counters) → 429 with a friendly ro message rendered in the widget.
6. **UI**: floating chat widget (config-toggleable per site) + `/asistent`
   full page. Streaming rendering, disclaimer line above the input on first
   open, "new conversation" reset.
7. **Env**: `CHAT_PROVIDER`, `ANTHROPIC_API_KEY` (never required in dev/tests)
   in `.env.example`.

## Steps

1. Provider interface + mock + unit tests; Anthropic impl (compile-tested +
   thin, no live-call tests).
2. Schema + session/token + rate limiting.
3. API streaming endpoint.
4. Widget + page UI wired to the mock.

## Tests

- Unit: provider selection logic (mock default; anthropic without key fails
  fast), rate-limit counters, history capping, message validation, session
  token sign/verify.
- Integration: POST /api/chat with mock provider streams a response and
  persists both messages; 21st message in the window → 429; foreign session
  token → 403.
- E2E: visitor opens the widget, sends a message, sees a streamed mock reply
  and the disclaimer; reset starts a new session.

## Definition of Done

- [ ] Gate green; e2e green — all with `CHAT_PROVIDER=mock`; zero live LLM
      calls anywhere in tests (assert no network attempt when key unset).
- [ ] The runner's own credentials are never read by the app (grep: the app
      references only its own `.env` names).
- [ ] Personas differ per site and are exercised: sleep boot uses sleep-coach,
      life boot uses life-coach (test on config resolution).
- [ ] `docs/STATE.md` updated; all work committed.
