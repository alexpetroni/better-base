# Deploying better-base

One codebase, one schema, N deployments. A deployment is selected by `SITE_ID`
(`sleep` for better-sleep, later `life` for better-life) and gets its **own**
database and media bucket. Nothing else differs between sites — no code
changes, no per-site branches.

This document assumes a Linux host (or PaaS) that can run a Node 24+ process,
plus Postgres 16, an S3-compatible object store and one imgproxy instance.

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
| `ADDRESS_HEADER`, `XFF_DEPTH` | see §3 | REQUIRED behind any proxy so rate limits key real client IPs, and dangerous if set wrong — read §3 before setting. |

The server validates the whole matrix at boot and **refuses to start** with a
message listing every missing variable (plus `RESEND_API_KEY` when
`EMAIL_DRYRUN=false`, and `STRIPE_WEBHOOK_SECRET` when a real Stripe key is
set) — a bad deploy fails at startup, never as 500s on first use.

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
key/salt are set — unsigned or tampered URLs get 403.

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
| daily, e.g. `15 3 * * *` | `pnpm chat:prune` (repo checkout with the site's env) | Deletes chat sessions older than 30 days (GDPR retention; messages cascade). |

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
