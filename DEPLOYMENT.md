# Deploying better-base

One codebase, one schema, N deployments. A deployment is selected by `SITE_ID`
(`sleep` for better-sleep, later `life` for better-life) and gets its **own**
database and media bucket. Nothing else differs between sites — no code
changes, no per-site branches.

This document assumes a Linux host (or PaaS) that can run a Node 24+ process,
plus Postgres 16, an S3-compatible object store and an image provider (§6 —
Cloudflare by default, so usually nothing extra to run).
**§12 covers the serverless alternative: Vercel + Neon**, which uses the same
codebase and the same env matrix with three variables changed.

## 1. Architecture at a glance

```
                    ┌─────────────────────────────┐
   bettersleep.ro ─▶│ node build/  (SITE_ID=sleep)│──▶ Postgres db: better_sleep
                    └─────────────────────────────┘        │
                                 │ presigned PUTs          │
                                 ▼                         │
                    R2 bucket: bettersleep-media ◀─────────┘ (media rows hold keys)
                                 │ public custom domain
                                 ▼
              media.bettersleep.ro ──▶ bettersleep.ro/cdn-cgi/image/<opts>/<src>
                                          Cloudflare transforms + caches at the edge
   betterlife.ro  ─▶ second deployment: SITE_ID=life, db better_life, bucket betterlife-media
```

- The app itself **never serves image bytes** — HTML embeds URLs the selected
  image provider answers; the browser PUTs uploads straight to storage via
  presigned URLs.
- On the default (Cloudflare) provider there is **nothing of ours to keep
  running** for images: R2 stores, Cloudflare transforms. That is what makes
  the Vercel target Vercel + Neon + Cloudflare and nothing else (§6, §12).

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
| `IMAGE_PROVIDER` | `cloudflare` (deploys), unset = `direct` (dev) | Who builds image URLs (§6). `launch:check` refuses `direct` on a real deploy. |
| `MEDIA_PUBLIC_BASE_URL` | e.g. `https://media.bettersleep.ro` | Public origin serving the stored originals — the R2 bucket's custom domain (§5). Required by `cloudflare`; in dev it is derived from `S3_ENDPOINT` + `S3_BUCKET`. Must be https in prod. |
| `CF_IMAGE_BASE_URL` | unset | Zone serving `/cdn-cgi/image`. Defaults to `PUBLIC_SITE_URL`; set only when the media bucket is on a different zone than the site. |
| `IMGPROXY_URL` | e.g. `https://img.bettersleep.ro` | `IMAGE_PROVIDER=imgproxy` only. Browser-reachable base URL embedded in `<img>` tags. |
| `IMGPROXY_KEY`, `IMGPROXY_SALT` | `openssl rand -hex 32` (twice) | `IMAGE_PROVIDER=imgproxy` only. MUST match the imgproxy process's own `IMGPROXY_KEY`/`IMGPROXY_SALT`. |
| `CHAT_PROVIDER` | `anthropic` (prod) | With `anthropic` the server **refuses to boot** without `ANTHROPIC_API_KEY` — no silent mock fallback. Keep `mock` if the assistant should not use the live API yet. |
| `ANTHROPIC_API_KEY` | from Anthropic console | Only read when `CHAT_PROVIDER=anthropic`. |
| `COURIER_PROVIDER` | `sameday` (prod) | With `sameday` the server **refuses to boot** without the three `SAMEDAY_*` values below — no silent mock fallback. Keep `mock` (the default) until the courier account exists; AWB generation then produces deterministic fake AWBs, clearly not real shipments. |
| `SAMEDAY_USERNAME`, `SAMEDAY_PASSWORD`, `SAMEDAY_PICKUP_POINT` | from the Sameday eAWB contract (§9) | Only read when `COURIER_PROVIDER=sameday`. The pickup point is the id of the warehouse parcels leave from. Optional overrides: `SAMEDAY_BASE_URL`, `SAMEDAY_SERVICE_ID` (default 7 = standard 24h), `SAMEDAY_TIMEOUT_MS`. |
| `ADDRESS_HEADER`, `XFF_DEPTH` | see §3 | REQUIRED behind any proxy so rate limits key real client IPs, and dangerous if set wrong — read §3 before setting. **adapter-node only** — on Vercel the platform resolves the client IP itself (§12). |
| `DEPLOY_TARGET` | unset (`node`) | Only for building the Vercel output locally; Vercel sets `VERCEL=1` itself (§12). |
| `DB_DRIVER` | unset (`pg`) | `neon` selects the serverless WebSocket driver (§12). An unknown value refuses to boot. |
| `DIRECT_DATABASE_URL` | unset | Migrations only: an unpooled connection for DDL (§12). Falls back to `DATABASE_URL`. |
| `CRON_SECRET` | unset | Required only where the scheduled jobs (retention, shipment-status sync — §9) run over HTTP instead of machine cron (§12). |
| `PUBLIC_ANALYTICS_PROVIDER` | unset | Optional. `plausible` or `umami`; unset = NO analytics script ships. When set, `PUBLIC_ANALYTICS_HOST` (service origin) and `PUBLIC_ANALYTICS_SITE_ID` (Plausible `data-domain` / Umami website id) are required — `launch:check` and the seam itself refuse a half-set trio. The script loads client-side ONLY after the visitor grants cookie consent, never on `/admin`. |

The server validates the whole matrix at boot and **refuses to start** with a
message listing every missing variable (plus whatever the selected
`IMAGE_PROVIDER` needs, `RESEND_API_KEY` when
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
(`DIRECT_DATABASE_URL`, `CRON_SECRET`), and a live image probe: it uploads a
1×1 PNG with the app's S3 credentials and then asks the selected provider for
a derivative of it. Under `cloudflare` that means the public origin must
answer 200 (proving the R2 custom domain is bound) and the `/cdn-cgi/image`
URL must come back as real webp (proving transformations are actually enabled
— a zone with them off returns the untouched source with a 200, which is the
one failure that otherwise looks healthy). Under `imgproxy` the signed URL
must answer 200 and an unsigned one 403, proving key/salt agree between app
and imgproxy and that imgproxy can read the bucket. It also reads the target
database's `site_settings` and fails while any launch-required setting
(company identification, ANPC/SOL links, invoice series/VAT rate — see
`src/lib/modules/settings/registry.ts`) is unset, still the seeded
`PLACEHOLDER — …` value, or invalid: fill them in at `/admin/settings`.
Non-zero exit with a numbered report on any problem. Flags: `--dev` (local
dev acknowledgement: dev defaults, http and placeholder settings are fine,
everything else still checked), `--no-probe` (env-only: skips both the
image probe and the site-settings database read, e.g. for CI),
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
bucket-creation rights.

**Public read access** depends on the image provider (§6). Under `cloudflare`
(the default) the bucket must be reachable at a public custom domain, because
that is the source URL Cloudflare fetches — bind one in the R2 dashboard
(Settings → Public access → Custom domain), e.g. `media.bettersleep.ro`, and
set it as `MEDIA_PUBLIC_BASE_URL`. Keep the domain on the SAME Cloudflare zone
as the site, so the transform endpoint is allowed to fetch from it and no one
else can point their zone at your bucket. Under `imgproxy` the bucket stays
fully private and imgproxy reads it with its own credentials.

What is public is the *original bytes at an unguessable key* (`uploads/<year>/
<month>/<slug>-<8 hex>.<ext>`), never a listing: grant `s3:GetObject` only.
Uploaded SVGs are sanitized at confirm time and stored with
`Content-Disposition: attachment`, so a crafted SVG cannot execute on the
media origin.

## 6. Image delivery (`IMAGE_PROVIDER`)

Every `<img>` on the site is built by one of three providers, chosen with
`IMAGE_PROVIDER`. The rendered contract (`ImageSources`: src, webp/avif
srcsets, width/height, blurhash placeholder) is identical either way — pages
and components never know which one is configured.

| `IMAGE_PROVIDER` | Who resizes | Needs | Use for |
| --- | --- | --- | --- |
| `cloudflare` (default for deploys) | Cloudflare, at the edge | `MEDIA_PUBLIC_BASE_URL`, a Cloudflare zone | Vercel target — nothing always-on |
| `imgproxy` | your own container | `IMGPROXY_URL/KEY/SALT` | VPS target, or full control of the pipeline |
| `direct` | nobody — originals as-is | `S3_*` only | local dev + the test suite ONLY |

`pnpm launch:check` refuses `direct` on a real deploy and probes whichever of
the other two is selected end-to-end (§ below).

### `cloudflare` — the default

URLs look like:

```
https://bettersleep.ro/cdn-cgi/image/width=768,fit=scale-down,format=webp,metadata=none/https://media.bettersleep.ro/uploads/2026/08/coperta-1a2b3c4d.jpg
```

Setup, once:

1. Bind the R2 bucket to a public custom domain on your zone (§5) and set
   `MEDIA_PUBLIC_BASE_URL=https://media.bettersleep.ro`.
2. Enable **Image Transformations** for the zone: Cloudflare dashboard →
   Images → Transformations → enable for `bettersleep.ro`. Check the current
   pricing and free allowance for your plan; billing is per *unique*
   transformation per month, and cached repeats are free — our URL options are
   emitted in a fixed order precisely so the same derivative is never billed
   twice under two spellings.
3. Leave `CF_IMAGE_BASE_URL` unset (it defaults to `PUBLIC_SITE_URL`) unless
   the media bucket lives on a different zone than the site.

There is no signing key. Cloudflare only transforms sources it is allowed to
fetch, and ours is our own R2 origin on our own zone — so the exposure is
"anyone who knows a storage key can request other sizes of that image",
not imgproxy's "anyone can transform anything". Do not add other hosts to the
zone's allowed origins unless you want them proxied.

**What breaks silently:** with transformations *off*, `/cdn-cgi/image/…`
answers 200 and passes the source through untouched — the site looks fine and
serves full-size originals to every visitor. `launch:check` catches exactly
this by requesting `format=webp` and asserting the response really is webp.

**Caching** is automatic: transformed responses are edge-cached by URL, and
the URLs are immutable (options + key; re-uploads get new keys).

### `imgproxy` — the self-hosted alternative

Run the container `ghcr.io/imgproxy/imgproxy:v3` (any host that can reach R2),
env:

```
IMGPROXY_KEY=<hex from openssl rand -hex 32>        # same values the app gets
IMGPROXY_SALT=<hex from openssl rand -hex 32>
IMGPROXY_SANITIZE_SVG=true                          # defense in depth; see below
IMGPROXY_MAX_SRC_FILE_SIZE=15728640                 # 15 MiB, = the app's upload cap
IMGPROXY_MAX_SRC_RESOLUTION=50                      # megapixels; decompression-bomb guard
IMGPROXY_USE_S3=true
IMGPROXY_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<R2 token key>                    # read-only token is enough
AWS_SECRET_ACCESS_KEY=<R2 token secret>
AWS_REGION=auto
```

Expose it at a public hostname (e.g. `img.bettersleep.ro`), set that as
`IMGPROXY_URL` and set `IMAGE_PROVIDER=imgproxy`. Signature enforcement is on
by default when key/salt are set — unsigned or tampered URLs get 403. A
ready-made host config lives in `deploy/imgproxy/` (Fly.io). Locally the
container is behind a compose profile: `docker compose --profile imgproxy up -d`.

**Key/salt hygiene & rotation.** There are NO committed defaults anywhere
(docker-compose refuses to start without a pair in `.env`; the app's boot
check does the same) — generate a unique pair per environment and never reuse
the pair from another deploy. To rotate: generate a new pair, update the
imgproxy process AND the app env together, restart both. Pages sign URLs per
request, so newly rendered pages work immediately; already-CDN-cached image
responses keep serving until their edge TTL expires (fine — the cache key is
the old URL), while uncached old URLs start returning 403.

**Cloudflare cache note:** imgproxy re-transforms on every request. Put the
imgproxy hostname behind Cloudflare (orange cloud) with a cache rule
"Cache Everything" + long edge TTL. One shared imgproxy instance can serve
both sites' buckets.

### SVGs

An SVG is active content and nothing rasterizes it. It is neutralized **at
upload**, once, rather than on every serve: `confirmUpload` strips scripts,
event handlers and remote references, writes the clean bytes back over the
original, and sets `Content-Disposition: attachment` on the object. Both
layers matter — the sanitizer removes the payload, the header means even a
sanitizer miss downloads instead of executing on the media origin. imgproxy's
`IMGPROXY_SANITIZE_SVG` stays on as a third layer on that target.

### `direct` — local only

Serves the stored original untouched. This is why `docker compose up -d`
brings up Postgres and MinIO only, and why the test suite needs no transformer:
there is nothing to run. srcsets come back empty and blurhashes are skipped
rather than faked, so what you see locally is honest about what it is.
`pnpm storage:init` grants the bucket anonymous read so the browser can fetch
originals; `pnpm media:blurhash` refuses to run on this provider.

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

### Fiscal documents (invoice PDF + e-Factura XML)

Every issued invoice renders deterministically to a PDF and a UBL 2.1
(CIUS-RO) XML, stored write-once in the S3/R2 bucket under the private
`invoices/` prefix (same bucket as media, different prefix — never reachable
through the image provider). Nothing to deploy: rendering is pure JS inside the app (works on
Vercel), the confirmation email attaches the PDF, customers reach their
documents through signed links on the order success page, and
`/admin/orders/export?month=YYYY-MM` gives the accountant a monthly zip
(CSV index + all PDFs/XMLs). `TOKEN_SECRET` (already required) signs the
customer download links.

**e-Factura submission to ANAF SPV is NOT automated** — it requires
enrollment only a human can do. Until then the app produces the compliant
XML artifact and an operator uploads it manually in the SPV web interface
when required. To enable automated submission later, a human must:

1. Obtain a **qualified digital certificate** for the company's legal
   representative (certSIGN/DigiSign/AlfaSign…).
2. Register the certificate and **enroll the CUI in SPV** (Spațiul Privat
   Virtual) on anaf.ro.
3. Register an OAuth application in the ANAF developer portal
   (logincert.anaf.ro) to obtain client id/secret and a refresh token for
   the e-Factura API.
4. Implement the `EFacturaSubmitter` adapter
   (`apps/web/src/lib/modules/invoice/efactura-submitter.ts`) against those
   credentials. The seam is in place; setting `ANAF_EFACTURA_ENABLED=true`
   before the adapter exists is a hard boot error by design — the app never
   fakes a submission.

Known artifact gap (documented in `modules/invoice/README.md`): the XML
omits the ISO 3166-2:RO county code (`CountrySubentity`) because the fiscal
snapshot stores flattened address strings; ANAF's validator wants it for RO
addresses. Resolve it together with the adapter work (extend the snapshot),
or accept manual SPV upload with ANAF's web validation until then.

### Shipping (courier & AWB)

Shipping prices are site settings (`/admin/settings` → Magazin): the standard
option's price is launch-required — `launch:check` fails until it is
consciously saved (0 is a valid, deliberate "we ship free"). The cart offers
the configured options, Stripe charges the selected one, the invoice carries
it as its own VAT line, and the admin order detail generates the AWB through
the `CourierProvider` seam (`apps/web/src/lib/modules/shop/courier.ts`).

The real adapter is **Sameday** (`COURIER_PROVIDER=sameday` + the `SAMEDAY_*`
credentials — §2). Sameday was chosen as Romania's largest e-commerce courier
with a public, token-authenticated REST API; the interface is
provider-agnostic, so a Cargus adapter would implement the same four calls.
The adapter follows Sameday's public API but has NOT been exercised against a
live account from this codebase — human launch steps:

1. Sign a Sameday business contract and get eAWB portal credentials
   (`SAMEDAY_USERNAME` / `SAMEDAY_PASSWORD`).
2. Create the pickup point (warehouse) in eAWB and put its id in
   `SAMEDAY_PICKUP_POINT`; pick the service with Sameday (standard 24h is
   service 7, the default — override with `SAMEDAY_SERVICE_ID` if the
   contract says otherwise).
3. Set `COURIER_PROVIDER=sameday` and redeploy — a half-set config refuses
   to boot.
4. **Verify with one real AWB**: generate it from a (test) paid order in
   `/admin/orders/[id]`, download the label, confirm the shipment appears in
   the eAWB dashboard, then cancel it there. Until this step passes, treat
   the adapter as unverified against the live API.

Until then `COURIER_PROVIDER=mock` keeps everything working end-to-end with
deterministic fake AWBs (dev/test default) — usable for staging, never for a
real customer parcel.

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
| hourly, e.g. `7 * * * *` | `curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/shipment-sync` | Polls the courier for every in-flight AWB (bounded batch per run, oldest first), updates shipment + fulfillment state (`delivered`/`returned`) and appends order events. Safe to run twice; a pure no-op while nothing is in flight. Runs through the app (it needs the courier adapter), so the machine-cron form IS the curl — set `CRON_SECRET` on adapter-node deployments too. |
| every 15 min, e.g. `*/15 * * * *` | `curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/nurture-send` | Drains the nurture email queue: claims a bounded batch of due sends (25/run), re-checks the marketing consent per send, mails through the idempotent email wrapper, retries failures with backoff and parks them after 5 attempts (visible in `/admin/nurture`). Concurrency-safe (`FOR UPDATE SKIP LOCKED` claim), so an overlapping run cannot double-send. A no-op while nothing is due — and while `EMAIL_DRYRUN` is unset it only records to `email_log`. Design notes: `src/lib/modules/nurture/README.md`. |

Where no machine can run scripts (Vercel), the retention job is also
available over HTTP at `GET /api/cron/chat-prune` — see §12. Both forms call
`runRetentionSweep()` in `src/lib/server/retention.ts`, so they cannot drift
apart (the sweep also expires closed nurture enrollments after 180 days). On
Vercel all three routes are scheduled by `apps/web/vercel.json`.

On-demand (not cron): `pnpm subscriber:delete -- --email x@y.ro` for GDPR
erasure requests (deletes the subscriber, unlinks quiz results, anonymizes
orders + email log); `pnpm media:blurhash` to backfill image placeholders for
media rows that predate confirm-time encoding (content imports, upgrades —
idempotent and resumable: only null rows are touched, failures are reported
and retried on the next run); and `pnpm content export/import` to copy an
article, quiz or product between sites:

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

Rehearsed end-to-end against the local stack on 2026-08-08 — the executed
walk, with commands and outputs, is `docs/LAUNCH-DRY-RUN.md`.

1. `curl https://<site>/api/health` → `200 {"status":"ok",…}`.
2. Open `/` — pillars render, cookie banner appears, footer links to the
   legal pages work and (once `/admin/settings` is filled) the footer shows
   the company identification + ANPC SAL/SOL links.
3. `/admin/login` with the created admin; upload an image in /admin/media and
   confirm the thumbnail renders (proves R2 + the image provider). The new
   row also gets a `blurhash` — visible as a blurred placeholder while images
   load on slow connections.
4. Complete the quiz, leave an email → check `email_log` (or the inbox once
   dry-run is off).
5. Test-mode purchase → order appears in /admin/orders as `plătită` with its
   invoice issued automatically: numbered in the declared series, PDF + XML
   downloadable from the order page and the success page, and the
   confirmation email (in `email_log`, or the inbox) carries the PDF.
6. Generate the AWB from the order's detail page — with
   `COURIER_PROVIDER=sameday` this doubles as the live verification of §7
   "Shipping" step 4; with `mock` it proves the flow with a clearly-fake AWB.
   The shipping email with the tracking link lands in `email_log`.
7. The three scheduled routes answer the authorized curls from §12
   ("Scheduled jobs") with 200 JSON on BOTH targets — adapter-node machine
   cron uses the same curls (§9) — and answer 401 without the Bearer.
8. If `PUBLIC_ANALYTICS_*` is set: the analytics script loads ONLY after
   accepting the cookie banner, and stops loading after "Retrage acordul" on
   the cookie-policy page.
9. Chat: send a message, reload the page — the conversation is restored from
   the server (history restore rides the session cookie).
10. `robots.txt`, `sitemap.xml` reachable; `/nu-exista` renders the 404 page.
11. Security headers (FIX-9): `curl -sI https://<site>/` shows
    `content-security-policy` (enforced, NOT report-only — includes
    `strict-dynamic`, `form-action 'self' https://checkout.stripe.com`,
    `frame-ancestors 'none'`), `strict-transport-security` (https only),
    `x-content-type-options: nosniff`, `referrer-policy`,
    `x-frame-options: DENY`, `permissions-policy`; and
    `curl -sI https://<site>/admin/login` shows
    `cache-control: private, no-store`. The CSP's img/connect sources are
    DERIVED from `MEDIA_PUBLIC_BASE_URL`/`S3_ENDPOINT`/`CF_IMAGE_BASE_URL`/
    `PUBLIC_ANALYTICS_HOST` at runtime — if images or the admin upload break
    after an env change, re-check those four first. Do not validate CSP on
    the dev server: SvelteKit strips `strict-dynamic` there; use
    `pnpm build && pnpm preview`.
12. If media rows predate this deploy (a content import, or an upgrade from a
    build without blurhash): `pnpm media:blurhash` once — a re-run printing
    `filled 0` confirms nothing is left.

## 12. Serverless: Vercel + Neon

The same codebase deploys to Vercel with Neon as the database. Nothing forks —
the target is chosen by environment variables, and with them unset the app
builds and runs exactly as §1–§11 describe.

```
   bettersleep.ro ─▶ Vercel functions (nodejs22.x, SITE_ID=sleep) ─▶ Neon (pooled endpoint)
                              │ presigned PUTs
                              ▼
                     R2 bucket: bettersleep-media
                              │ public custom domain
                              ▼
              media.bettersleep.ro ──▶ /cdn-cgi/image/… (Cloudflare edge)
```

**Images run on Cloudflare — decided (revised).** The Vercel target now needs
**no always-on infrastructure of its own**: R2 stores the originals, the
zone's Image Transformations endpoint resizes and caches them, and both are
Cloudflare products we already depend on for DNS and storage. Set
`IMAGE_PROVIDER=cloudflare` and `MEDIA_PUBLIC_BASE_URL`; §6 has the two
dashboard steps. Cost is per unique transformation per month against the
zone's plan allowance, rather than a fixed monthly machine.

This replaces the earlier decision to run **imgproxy on Fly.io**, which stood
while `imageSources()` could only build signed imgproxy URLs. That coupling is
gone: image URL building is now a provider seam
(`src/lib/modules/media/image.ts` + one file per provider), so switching costs
one environment variable instead of a refactor of the code every page renders
through. The Fly config stays committed at `deploy/imgproxy/fly.toml` and
`IMAGE_PROVIDER=imgproxy` still works — choose it if you want the transform
pipeline entirely under your own control, or if you are already running a VPS
for an adapter-node deploy (§6). Its cost was a few dollars a month for Fly's
smallest always-on `shared-cpu-1x`/512 MB machine in region `otp`.

Vercel Image Optimization remains rejected: it would bind image delivery to
one host, which is exactly the coupling this seam removed.

### What changes

| Variable | Value | Why |
| --- | --- | --- |
| `DB_DRIVER` | `neon` | Neon's serverless driver over WebSockets. HTTP is not an option: `db.transaction()` is used by the blog, shop and GDPR services. Also shrinks the pool to 1 connection per function instance (`DB_POOL_MAX` overrides). |
| `DATABASE_URL` | Neon **pooled** URL (`…-pooler.…neon.tech/db?sslmode=require`) | Functions are short-lived; the pooler absorbs their connection churn. |
| `DIRECT_DATABASE_URL` | Neon **unpooled** URL | Migrations only. DDL through PgBouncer's transaction mode is unreliable; `drizzle.config.ts` prefers this and falls back to `DATABASE_URL`. |
| `CRON_SECRET` | `openssl rand -hex 32` | Guards the retention route below. Vercel Cron sends it as `Authorization: Bearer …` automatically. |
| `ADDRESS_HEADER`, `XFF_DEPTH` | **leave unset** | Vercel resolves the client IP itself. Setting them here would let a caller spoof `getClientAddress()` and defeat every rate limit. |

Everything else — `SITE_ID`, `PUBLIC_SITE_URL`, the S3/R2 block, the image
provider block, Stripe, Resend, chat — is identical to §2. Boot validation is unchanged,
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
DATABASE_URL="…-pooler…" pnpm media:blurhash                           # placeholders for imported media
DATABASE_URL="…-pooler…" pnpm user:create -- --email you@x.ro --role admin --password '…'
```

`pnpm db:seed` uploads the placeholder product images, so it needs the R2
credentials too. All of these are idempotent — safe to re-run on later deploys.

### Scheduled jobs

`vercel.json` schedules `GET /api/cron/chat-prune` daily (retention),
`GET /api/cron/shipment-sync` hourly (courier tracking poll — §9) and
`GET /api/cron/nurture-send` every 15 minutes (nurture email queue — §9).
All routes require `Authorization: Bearer $CRON_SECRET`; without
`CRON_SECRET` set they answer `503` rather than running unauthenticated.
Verify once by hand:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/chat-prune
# {"sessions":0,"chatRateLimitRows":0,…,"retentionDays":30}
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/shipment-sync
# {"polled":0,"updated":0,"errors":0}
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/nurture-send
# {"claimed":0,"sent":0,"retried":0,"parked":0,"cancelled":0,"completed":0}
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
docker compose --profile neon up -d --build   # db + minio + neon-proxy
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
- **No always-on box of our own.** Images go through Cloudflare Image
  Transformations (`IMAGE_PROVIDER=cloudflare`), so the deploy is Vercel +
  Neon + Cloudflare. The former imgproxy-on-Fly requirement is now an option,
  not a dependency — see the revised decision above.
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
