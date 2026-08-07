# Deploying better-base

One codebase, one schema, N deployments. A deployment is selected by `SITE_ID`
(`sleep` for better-sleep, later `life` for better-life) and gets its **own**
database and media bucket. Nothing else differs between sites — no code
changes, no per-site branches.

This document assumes a Linux host (or PaaS) that can run a Node 24+ process,
plus Postgres 16, an S3-compatible object store and one imgproxy instance.
**§12 covers the serverless alternative: Vercel + Neon**, which uses the same
codebase and the same env matrix with three variables changed.

## 1. Architecture at a glance

```
                    ┌─────────────────────────────┐
   bettersleep.ro ─▶│ node build/  (SITE_ID=sleep)│──▶ Postgres db: better_sleep
                    └─────────────────────────────┘        │
                                 │ presigned PUTs / reads  │
                                 ▼                         │
                    R2 bucket: bettersleep-media ◀─────────┘ (media rows hold keys)
                                 ▲
                    ┌────────────┴────────────┐
   img.example.com ─▶  imgproxy (shared OK)   │  signed URLs, reads s3://<bucket>/<key>
                    └─────────────────────────┘
   betterlife.ro  ─▶ second deployment: SITE_ID=life, db better_life, bucket betterlife-media
```

- The app itself **never serves image bytes** — HTML embeds signed imgproxy
  URLs; the browser PUTs uploads straight to storage via presigned URLs.
- One imgproxy instance may serve both sites (it just reads whatever
  `s3://bucket/key` the signed URL names), or run one per site — either works.

## 2. Environment matrix

All configuration is environment variables (see `.env.example` for the
documented dev values). Per-site values:

| Variable | better-sleep | better-life | Notes |
| --- | --- | --- | --- |
| `SITE_ID` | `sleep` | `life` | Selects the site config at boot. |
| `DATABASE_URL` | `postgres://…/better_sleep` | `postgres://…/better_life` | One database per site, identical schema. |
| `PUBLIC_SITE_URL` | `https://bettersleep.ro` | `https://betterlife.ro` | Canonical origin: links in emails, sitemap, OG tags, Stripe redirect URLs. Must be https in prod (session cookies derive `Secure` from it). |
| `S3_BUCKET` | e.g. `bettersleep-media` | e.g. `betterlife-media` | One bucket per site. |
| `BETTER_AUTH_SECRET` | unique 32+ random bytes | unique 32+ random bytes | `openssl rand -base64 32`. Signs staff sessions only. Rotating it logs staff out. |
| `TOKEN_SECRET` | unique 32+ random bytes | unique 32+ random bytes | `openssl rand -base64 32`. Signs newsletter confirm links, chat session cookies and upload-confirm tickets. MUST differ from `BETTER_AUTH_SECRET` (boot refuses otherwise). Rotating it invalidates outstanding confirm links and chat sessions (users just start a fresh conversation). |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | per-site Stripe account or shared account | 〃 | See §6. |
| `RESEND_API_KEY` + `EMAIL_DRYRUN=false` | per-site sending domain | 〃 | See §7. |

Shared (may be identical on both sites):

| Variable | Value | Notes |
| --- | --- | --- |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | from R2 (§5) | The endpoint must be reachable by **both** the server and browsers (uploads PUT directly to presigned URLs). R2's public S3 endpoint satisfies this. |
| `IMGPROXY_URL` | e.g. `https://img.bettersleep.ro` | Browser-reachable base URL embedded in `<img>` tags. |
| `IMGPROXY_KEY`, `IMGPROXY_SALT` | `openssl rand -hex 32` (twice) | MUST match the imgproxy process's own `IMGPROXY_KEY`/`IMGPROXY_SALT`. |
| `CHAT_PROVIDER` | `anthropic` (prod) | With `anthropic` the server **refuses to boot** without `ANTHROPIC_API_KEY` — no silent mock fallback. Keep `mock` if the assistant should not use the live API yet. |
| `ANTHROPIC_API_KEY` | from Anthropic console | Only read when `CHAT_PROVIDER=anthropic`. |
| `ADDRESS_HEADER`, `XFF_DEPTH` | see §3 | REQUIRED behind any proxy so rate limits key real client IPs, and dangerous if set wrong — read §3 before setting. **adapter-node only** — on Vercel the platform resolves the client IP itself (§12). |
| `DEPLOY_TARGET` | unset (`node`) | Only for building the Vercel output locally; Vercel sets `VERCEL=1` itself (§12). |
| `DB_DRIVER` | unset (`pg`) | `neon` selects the serverless WebSocket driver (§12). An unknown value refuses to boot. |
| `DIRECT_DATABASE_URL` | unset | Migrations only: an unpooled connection for DDL (§12). Falls back to `DATABASE_URL`. |
| `CRON_SECRET` | unset | Required only where the retention job runs over HTTP instead of cron (§12). |
| `PUBLIC_ANALYTICS_PROVIDER` | unset | Optional. `plausible` or `umami`; unset = NO analytics script ships. When set, `PUBLIC_ANALYTICS_HOST` (service origin) and `PUBLIC_ANALYTICS_SITE_ID` (Plausible `data-domain` / Umami website id) are required — `launch:check` and the seam itself refuse a half-set trio. The script loads client-side ONLY after the visitor grants cookie consent, never on `/admin`. |

The server validates the whole matrix at boot and **refuses to start** with a
message listing every missing variable (plus `RESEND_API_KEY` when
`EMAIL_DRYRUN=false`, and `STRIPE_WEBHOOK_SECRET` when a real Stripe key is
set) — a bad deploy fails at startup, never as 500s on first use.

**Preflight: `pnpm launch:check`.** Before a deploy, run it with the target
environment's variables exported (exported values win over the root `.env`).
It re-checks the same matrix from the outside — the list is the SAME
declaration the boot check uses (`src/lib/server/env-matrix.ts`), so the two
cannot drift — and adds the launch-only rules a running app cannot judge:
no committed dev default anywhere (secrets, MinIO/compose credentials,
Stripe webhook dev value), `PUBLIC_SITE_URL` https and matching the
`SITE_ID`'s domain, live-mode implications (`EMAIL_DRYRUN=false` ⇒
`RESEND_API_KEY`, no `sk_test_…` key), the Vercel extras
(`DIRECT_DATABASE_URL`, `CRON_SECRET`), and a live imgproxy probe: it uploads
a 1×1 PNG with the app's S3 credentials and requires the signed imgproxy URL
to answer 200 and an unsigned one 403 — proving key/salt agree between app
and imgproxy and that imgproxy can read the bucket. It also reads the target
database's `site_settings` and fails while any launch-required setting
(company identification, ANPC/SOL links, invoice series/VAT rate — see
`src/lib/modules/settings/registry.ts`) is unset, still the seeded
`PLACEHOLDER — …` value, or invalid: fill them in at `/admin/settings`.
Non-zero exit with a numbered report on any problem. Flags: `--dev` (local
dev acknowledgement: dev defaults, http and placeholder settings are fine,
everything else still checked), `--no-probe` (env-only: skips both the
imgproxy probe and the site-settings database read, e.g. for CI),
`--target=node|vercel` (default: `vercel` when `VERCEL`/`DEPLOY_TARGET=vercel`
is set, else `node`).

Not used in prod: `TEST_DATABASE_URL`, `DB_PORT`, `MINIO_*`, `IMGPROXY_PORT`
(compose/dev knobs only).

## 3. Build & run

```bash
pnpm install               # also builds packages/formcomp (prepare script)
pnpm build                 # SvelteKit adapter-node → apps/web/build/
node apps/web/build        # serves HTTP on PORT (default 3000)
```

- Set `PORT` (and optionally `ORIGIN=$PUBLIC_SITE_URL`, which adapter-node
  uses for form-action origin checks behind proxies).
- Run it under a supervisor (systemd, a container orchestrator, …). The
  process is stateless — carts/sessions live in cookies + Postgres — so
  horizontal scaling works.
- Put a TLS-terminating proxy in front (Caddy, nginx, Cloudflare). Forward
  `X-Forwarded-*` headers.
- adapter-node caps request bodies at 512 KiB by default (`BODY_SIZE_LIMIT`);
  keep that default — the app enforces tighter per-endpoint caps on top
  (32 KiB chat, 256 KiB quiz submissions).

### Client IPs behind the proxy (rate limiting)

Login, chat and public-email rate limits key on the client IP. Out of the box
the app uses the **socket address** — behind a proxy that is the proxy's own
IP, so all visitors share one bucket: a burst from anyone rate-limits
everyone, and per-IP caps do nothing against a single abuser. Configure
adapter-node's trust explicitly (env vars, read at runtime):

- **One proxy you control (Caddy/nginx → app):**
  `ADDRESS_HEADER=x-forwarded-for` and `XFF_DEPTH=1` (the rightmost XFF entry
  was appended by YOUR proxy and is spoof-proof; make the proxy overwrite —
  not append to — untrusted incoming XFF, or count every hop in `XFF_DEPTH`).
- **Cloudflare in front of your proxy:** `ADDRESS_HEADER=cf-connecting-ip`
  (set by Cloudflare itself, can't be spoofed as long as the origin only
  accepts Cloudflare traffic), or keep `x-forwarded-for` with `XFF_DEPTH=2`
  (two trusted hops: Cloudflare + your proxy).
- **No proxy (direct exposure):** set neither. NEVER set `ADDRESS_HEADER`
  to a header your edge does not strip/overwrite from client requests —
  that turns the rate limiter keys client-spoofable.

Health: `GET /api/health` returns `200 {status:'ok'}` when the database and
the bucket are reachable, `503` otherwise — point your uptime checks and load
balancer at it. Unhandled errors are logged to stderr as one JSON object per
line (`ts`, `level`, `errorId`, `status`, `method`, `path`, `message`,
`stack`); the user-facing error page shows the matching `errorId`.

## 4. Database: create, migrate, seed

Per site, on the shared or per-site Postgres 16 server:

```bash
createdb better_sleep      # (or CREATE DATABASE in psql; owner = app user)

# from the repo, with the site's env loaded:
pnpm db:migrate            # applies apps/web/drizzle/*.sql (additive, committed)
pnpm db:seed               # idempotent: pillars for SITE_ID, legal pages,
                           #   demo article/quiz/products (skip on prod? see note)
pnpm user:create -- --email you@site.ro --password '…min 12 chars…' --role admin
```

Notes:

- `pnpm db:migrate` must run on every deploy that ships new migrations. It is
  safe to re-run (drizzle tracks applied migrations).
- Seeding is idempotent. It upserts the site's pillars (required), creates the
  two legal pages **only if missing** (edits in /admin/pages are never
  overwritten), and upserts demo content. For a clean production launch you
  may delete the demo articles/quiz/products in the admin afterwards, or keep
  them until real content lands. Seeding demo products needs the bucket to
  exist (it uploads placeholder covers).
- Seeding also inserts `PLACEHOLDER — …` rows for the launch-required site
  settings (company identification, ANPC/SOL links, invoice series) — only
  where missing, so values saved in `/admin/settings` are never overwritten.
  Replace every placeholder before launch; `pnpm launch:check` refuses to
  pass while one stands.
- Staff users: `user:create` is idempotent by email (re-running updates
  role/password). Roles: `admin` (everything) / `editor` (content only).

## 5. Cloudflare R2 (media storage)

1. Create one bucket per site (e.g. `bettersleep-media`).
2. Create an R2 API token with Object Read & Write on that bucket.
3. Set `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`,
   `S3_ACCESS_KEY`/`S3_SECRET_KEY` from the token, `S3_REGION=auto`,
   `S3_BUCKET=<bucket>`.

No code changes vs MinIO: the storage layer is plain S3 API with path-style
addressing. `pnpm storage:init` (idempotent bucket creation) is optional on
R2 — the bucket is created in the dashboard; the token then does not need
bucket-creation rights. The bucket stays **private**: nothing serves originals
publicly; imgproxy reads them with its own credentials.

## 6. imgproxy (image transforms)

Run the container `ghcr.io/imgproxy/imgproxy:v3` (any host that can reach R2),
env:

```
IMGPROXY_KEY=<hex from openssl rand -hex 32>        # same values the app gets
IMGPROXY_SALT=<hex from openssl rand -hex 32>
IMGPROXY_SANITIZE_SVG=true                          # strip scripts from served SVGs
IMGPROXY_MAX_SRC_FILE_SIZE=15728640                 # 15 MiB, = the app's upload cap
IMGPROXY_MAX_SRC_RESOLUTION=50                      # megapixels; decompression-bomb guard
IMGPROXY_USE_S3=true
IMGPROXY_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<R2 token key>                    # read-only token is enough
AWS_SECRET_ACCESS_KEY=<R2 token secret>
AWS_REGION=auto
```

Expose it at a public hostname (e.g. `img.bettersleep.ro`) and set that as
`IMGPROXY_URL` for the app. Signature enforcement is on by default when
key/salt are set — unsigned or tampered URLs get 403. A ready-made host
config for exactly this container lives in `deploy/imgproxy/` (Fly.io, the
committed choice for the Vercel target — §12); a VPS that already runs the
app works just as well with the same env block.

**Key/salt hygiene & rotation.** There are NO committed defaults anywhere
(docker-compose refuses to start without a pair in `.env`; the app's boot
check does the same) — generate a unique pair per environment and never reuse
the pair from another deploy. To rotate: generate a new pair, update the
imgproxy process AND the app env together, restart both. Pages sign URLs per
request, so newly rendered pages work immediately; already-CDN-cached image
responses keep serving until their edge TTL expires (fine — the cache key is
the old URL), while uncached old URLs start returning 403. SVGs are always
served with `Content-Disposition: attachment` (the app signs `att:1` into
their URLs) so a stored SVG can never render as a page in the imgproxy
origin; keep `IMGPROXY_SANITIZE_SVG=true` as defense in depth.

**Cloudflare cache note:** imgproxy re-transforms on every request. Put the
imgproxy hostname behind Cloudflare (orange cloud) with a cache rule
"Cache Everything" + long edge TTL (transformed URLs are immutable: the
signature encodes the exact transform + source key, and re-uploads get new
keys). This gives CDN-cached images without any app changes. One shared
imgproxy instance can serve both sites' buckets.

## 7. Stripe (shop)

Per site (separate Stripe accounts recommended so payouts/branding stay per
brand — a shared account also works):

1. Set `STRIPE_SECRET_KEY` (test key first: `sk_test_…`).
2. Dashboard → Developers → Webhooks → Add endpoint:
   `https://<site>/api/stripe/webhook`, events:
   `checkout.session.completed`, `charge.refunded`.
3. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Orders are created **only** by the webhook (idempotent on the session id);
   duplicate deliveries are acknowledged and ignored. Verify with a test-mode
   purchase (card `4242 4242 4242 4242`) before switching to live keys.

The product catalog syncs to Stripe on admin save (product + price objects);
checkout itself snapshots prices from our database, so an unsynced catalog
never blocks selling. Local/dev with an empty `STRIPE_SECRET_KEY` runs a
deterministic in-memory mock — never leave it empty in prod.

## 8. Email (Resend)

1. Add and verify the sending domain in Resend (SPF + DKIM DNS records).
2. Set `RESEND_API_KEY` and `EMAIL_DRYRUN=false`.
3. The sender identity (`from`/`replyTo`) comes from the site config
   (`apps/web/src/lib/config/sites/<site>.ts`) — `salut@bettersleep.ro` must
   be under the verified domain.

With `EMAIL_DRYRUN=true` (the default) every "send" is only recorded in the
`email_log` table — that is the correct state until DNS is verified. All
sends are idempotent (unique `idempotency_key`), so retries never double-send.

## 9. Cron entries

| Schedule | Command | Purpose |
| --- | --- | --- |
| daily, e.g. `15 3 * * *` | `pnpm chat:prune` (repo checkout with the site's env) | Deletes chat sessions older than 30 days (GDPR retention; messages cascade), sweeps expired rate-limit counter rows, and prunes webhook idempotency-ledger rows (`processed_events`) older than 90 days. |

Where no machine can run scripts (Vercel), the same job is available over HTTP
at `GET /api/cron/chat-prune` — see §12. Both call `runRetentionSweep()` in
`src/lib/server/retention.ts`, so they cannot drift apart.

On-demand (not cron): `pnpm subscriber:delete -- --email x@y.ro` for GDPR
erasure requests (deletes the subscriber, unlinks quiz results, anonymizes
orders + email log), and `pnpm content export/import` to copy an article,
quiz or product between sites:

```bash
# on/with site A's env:
pnpm content export --type article --slug melatonina-si-lumina-albastra --out a.json
# with site B's env (its DATABASE_URL + S3_BUCKET):
pnpm content import a.json      # idempotent by slug; re-uploads media to B's bucket
```

## 10. Deploying the second site (better-life)

Repeat §3–§9 with `SITE_ID=life`, `DATABASE_URL=…/better_life`, its own
bucket, domain, Stripe account and Resend domain. The same build output can
be reused — `SITE_ID` is read at runtime, so two processes from one artifact
work (that is exactly how the e2e suite runs both sites from one build).
Content shared between sites travels via `pnpm content export/import` (§9).

## 11. Post-deploy verification

1. `curl https://<site>/api/health` → `200 {"status":"ok",…}`.
2. Open `/` — pillars render, cookie banner appears, footer links to the
   legal pages work.
3. `/admin/login` with the created admin; upload an image in /admin/media and
   confirm the thumbnail renders (proves R2 + imgproxy + signatures).
4. Complete the quiz, leave an email → check `email_log` (or the inbox once
   dry-run is off).
5. Test-mode purchase → order appears in /admin/orders as `plătită`.
6. `robots.txt`, `sitemap.xml` reachable; `/nu-exista` renders the 404 page.

## 12. Serverless: Vercel + Neon

The same codebase deploys to Vercel with Neon as the database. Nothing forks —
the target is chosen by environment variables, and with them unset the app
builds and runs exactly as §1–§11 describe.

```
   bettersleep.ro ─▶ Vercel functions (nodejs22.x, SITE_ID=sleep) ─▶ Neon (pooled endpoint)
                              │ presigned PUTs / reads
                              ▼
                     R2 bucket: bettersleep-media
                              ▲
                     imgproxy (Fly / Railway / a small VPS) ◀── signed URLs from the app
```

**imgproxy runs on Fly.io — decided.** Vercel cannot host it, and the app
signs imgproxy URLs for every image, so this is the one piece of always-on
infrastructure the setup needs. The committed config is
`deploy/imgproxy/fly.toml` (+ README with the exact `fly secrets set` lines):
the upstream `ghcr.io/imgproxy/imgproxy:v3` image, region `otp` (Bucharest —
the RO market next door), always-on `shared-cpu-1x`/512 MB, the `/health`
check wired, same key/salt as the app and a **read-only** R2 token of its
own, public hostname behind Cloudflare "Cache Everything" (§6). Cost: a few
dollars a month (Fly's smallest always-on machine; 256 MB was rejected
because large sources OOM the transformer). Alternatives considered:
Railway (~$5/mo minimum for the same container, no closer region), a small
VPS (similar price but reintroduces a machine to patch — sensible only if
one already exists for an adapter-node deploy, per §6), and Vercel Image
Optimization (rejected: it means refactoring `imageSources()` in
`src/lib/modules/media/imgproxy.ts`, which every page renders through — the
only option here with real regression risk).

### What changes

| Variable | Value | Why |
| --- | --- | --- |
| `DB_DRIVER` | `neon` | Neon's serverless driver over WebSockets. HTTP is not an option: `db.transaction()` is used by the blog, shop and GDPR services. Also shrinks the pool to 1 connection per function instance (`DB_POOL_MAX` overrides). |
| `DATABASE_URL` | Neon **pooled** URL (`…-pooler.…neon.tech/db?sslmode=require`) | Functions are short-lived; the pooler absorbs their connection churn. |
| `DIRECT_DATABASE_URL` | Neon **unpooled** URL | Migrations only. DDL through PgBouncer's transaction mode is unreliable; `drizzle.config.ts` prefers this and falls back to `DATABASE_URL`. |
| `CRON_SECRET` | `openssl rand -hex 32` | Guards the retention route below. Vercel Cron sends it as `Authorization: Bearer …` automatically. |
| `ADDRESS_HEADER`, `XFF_DEPTH` | **leave unset** | Vercel resolves the client IP itself. Setting them here would let a caller spoof `getClientAddress()` and defeat every rate limit. |

Everything else — `SITE_ID`, `PUBLIC_SITE_URL`, the S3/R2 block, the imgproxy
block, Stripe, Resend, chat — is identical to §2. Boot validation is unchanged,
so a missing variable still refuses the deploy with one message listing all of
them.

### Project setup

Vercel dashboard → New Project → import the repo:

- **Root Directory**: `apps/web`
- **Install Command**: `cd ../.. && pnpm install --frozen-lockfile` — the
  install must run at the repo root so pnpm builds `packages/formcomp` via its
  `prepare` script. Its `dist/` is gitignored, so an install scoped to
  `apps/web` produces a build that cannot resolve `formcomp`.
- **Build Command**: `pnpm build` (the adapter switches itself: Vercel sets
  `VERCEL=1`; `vite.config.ts` picks `adapter-vercel`, otherwise `adapter-node`)
- **Output**: `.vercel/output` (detected automatically)
- **Node version**: 22.x, matching the `runtime` the adapter requests. The Neon
  driver needs a global `WebSocket`.

`apps/web/vercel.json` ships the cron schedule. Function defaults are fine;
`/api/chat` declares `maxDuration = 60` in its `+server.ts` because the
assistant streams its reply and would otherwise be cut off at the plan default.

### CI migrations (GitHub Actions)

Migrations do **not** run during the build — a build is not a deploy, and
Vercel may run several concurrently. Their home is
`.github/workflows/migrate.yml`: it applies `apps/web/drizzle/*.sql` on every
push to `main` (so the schema is current before Vercel promotes that same
push) and on manual dispatch (Actions → migrate → Run workflow). The job is a
no-op when the database is already current, serializes concurrent runs, and
ends by printing the applied-migration list (`pnpm db:status` — runnable from
any checkout too; it exits non-zero while migrations are pending).

Wire it once: GitHub repo → Settings → Secrets and variables → Actions → New
repository secret, name `DIRECT_DATABASE_URL`, value = the site's **unpooled**
Neon URL (`postgres://…neon.tech/better_sleep?sslmode=require` — not the
`-pooler` host; DDL through PgBouncer's transaction mode is unreliable).
Without the secret the workflow fails closed on its first step, before
installing anything. It deliberately never seeds and never creates users —
those are one-off human steps below.

### Deploy order

First deploy only — run the one-off setup yourself from a checkout, with the
site's Neon URLs exported (later deploys need none of this; the workflow
keeps the schema current):

```bash
# from a checkout, with the site's Neon URLs exported:
DIRECT_DATABASE_URL="postgres://…neon.tech/better_sleep?sslmode=require" pnpm db:migrate
DATABASE_URL="…-pooler…" S3_ENDPOINT=… S3_BUCKET=… pnpm db:seed        # first deploy only
DATABASE_URL="…-pooler…" pnpm content:init                             # initial content, idempotent
DATABASE_URL="…-pooler…" pnpm user:create -- --email you@x.ro --role admin --password '…'
```

`pnpm db:seed` uploads the placeholder product images, so it needs the R2
credentials too. All of these are idempotent — safe to re-run on later deploys.

### Retention job

`vercel.json` schedules `GET /api/cron/chat-prune` daily. The route requires
`Authorization: Bearer $CRON_SECRET`; without `CRON_SECRET` set it answers
`503` rather than running unauthenticated. Verify once by hand:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/chat-prune
# {"sessions":0,"chatRateLimitRows":0,…,"retentionDays":30}
```

### Verification

§11 applies unchanged. Two additions worth doing on the first serverless
deploy, because they exercise what this target actually changes:

1. `/api/health` → `{"db":"ok","storage":"ok"}` proves the Neon driver and R2
   from inside a function.
2. Send a chat message and watch it stream token by token — that proves the
   Node runtime, response streaming and `maxDuration` together.

### Local Neon-protocol stack (proving `DB_DRIVER=neon` without an account)

The neon driver speaks Postgres over a WebSocket proxy, and that proxy runs
locally: the compose file ships a `neon-proxy` service — Neon's own `wsproxy`,
built from source at a pinned commit (`docker/wsproxy/Dockerfile`; the prebuilt
image is not anonymously pullable) — behind a compose **profile**, so a plain
`docker compose up -d` never builds or starts it.

```bash
docker compose --profile neon up -d --build   # db + minio + imgproxy + neon-proxy
pnpm test:neon                                # the FULL suite with DB_DRIVER=neon over ws://
```

`pnpm test:neon` runs every unit and integration spec through the WebSocket
transport — including the blog/shop/gdpr transaction paths and the drizzle
migrator — and fails loudly (with the command above in the message) rather than
skipping if the proxy is not up. The seam is `NEON_WS_PROXY` (`host:port`,
default `localhost:5488`, host-normalized like the other service vars): when
set, `db/client.ts` points the driver's `wsProxy` at it with
`useSecureWebSocket=false` (the local proxy is plain `ws://`) and
`pipelineConnect=false` (connect pipelining needs cleartext password auth;
compose Postgres uses SCRAM). The proxy only accepts `db:5432` as a target
(`ALLOW_ADDR_REGEX`). Against real Neon, leave `NEON_WS_PROXY` unset — the
driver derives the `wss://` endpoint from the connection string itself.

What this proves: the `SET statement_timeout` issued on connect is honored and
cancels runaway queries; interactive transactions commit and roll back over the
WebSocket; the two drivers expose the same client surface; and parallel work
through the driver's 1-connection-per-instance default queues on the single
connection instead of deadlocking (waits are bounded by
`DB_POOL_CONNECTION_TIMEOUT_MS`, so overload sheds instead of hanging). The
driver-level assertions live in `src/lib/db/driver-parity.spec.ts`.

### Known limits

- **Cold starts** hit the first request after idle: a fresh function opens a
  new Neon connection. The pooled endpoint keeps this in the tens of
  milliseconds; it is not zero.
- **One always-on box remains** for imgproxy — decided and committed: Fly.io,
  `deploy/imgproxy/` (see "imgproxy runs on Fly.io" above). Removing it means
  teaching the media layer a second transform provider (e.g. Vercel Image
  Optimization) — deliberately out of scope, since it would touch every
  page's rendering.
- **Residual risk — Neon's own pooler and TLS path are NOT covered by the local
  stack.** The local proxy proves the WebSocket transport and this codebase's
  driver seam; it cannot prove Neon's PgBouncer configuration (its startup-
  parameter allowlist, `SET` handling on the pooled endpoint) or the `wss://`
  TLS handshake. Before the first production deploy, run once against a real
  (free-tier) Neon project:

  ```bash
  DIRECT_DATABASE_URL="postgres://…neon.tech/better_sleep?sslmode=require" pnpm db:migrate
  DB_DRIVER=neon DATABASE_URL="…-pooler…" TEST_DATABASE_URL="…-pooler…/better_test" pnpm test:unit
  ```

  Until that has been done, treat `SET statement_timeout` behavior on Neon's
  pooled endpoint as unverified there (it is verified against vanilla Postgres
  through the real wsproxy).
