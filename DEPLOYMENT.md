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
| `S3_INVOICE_BUCKET` | e.g. `bettersleep-fiscal` | e.g. `betterlife-fiscal` | The PRIVATE bucket for invoice PDFs + e-Factura XML (§5). Required by `launch:check` under the `cloudflare` provider (the media bucket is public there); locally it defaults to `<S3_BUCKET>-fiscal`. Never bind it to a public domain. |
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
| `CRON_SECRET` | unset | Required only where the scheduled jobs (retention, shipment-status sync, nurture queue, e-Factura submission — §9) run over HTTP instead of machine cron (§12). |
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
`RESEND_API_KEY`, no `sk_test_…` key, no mock chat/courier provider unless
`--allow-mock-providers` acknowledges it), the Vercel extras
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

Health (FIX-16): `GET /api/health` is LIVENESS — `200 {status:'ok', site,
commit, chatProvider}` with no I/O, so a storage blip never drains an
instance that can still serve pages; `GET /api/health/ready` is READINESS —
`200 {status:'ok', checks:{db,storage}, chatProvider}` when the database and
the bucket are reachable, `503` otherwise — point your uptime checks and load
balancer at `/ready`. Every response carries `x-request-id` (Vercel's
`x-vercel-id`, else a UUID) and the error page shows it. Unhandled errors are
logged to stderr as one JSON object per line (`ts`, `level`, `errorId`,
`requestId`, `status`, `method`, `path`, `message`,
`stack`); the user-facing error page shows the matching `errorId`.

## 4. Database: create, migrate, seed

Per site, on the shared or per-site Postgres 16 server:

```bash
createdb better_sleep      # (or CREATE DATABASE in psql; owner = app user)

# from the repo, with the site's env loaded:
pnpm db:migrate            # applies apps/web/drizzle/*.sql (additive, committed)
pnpm seed:base             # pillars for SITE_ID, legal pages, placeholder settings,
                           #   nurture sequences, initial content from content/
pnpm seed:demo             # demo article/quiz/products — dev and staging only
pnpm user:create -- --email you@site.ro --role admin        # prompts for the password (no echo)
# non-interactive: printf '%s\n' "$ADMIN_PASSWORD" | pnpm user:create -- --email you@site.ro --role admin --password-stdin
```

Notes:

- `pnpm db:migrate` must run on every deploy that ships new migrations. It is
  safe to re-run (drizzle tracks applied migrations).
- **`pnpm seed:base` is safe to re-run on a live site** (FIX-15). It upserts
  the site's pillars (required) and nurture sequence definitions (the
  operator's active flag survives); everything an admin can edit is
  create-only: the two legal pages, the `PLACEHOLDER — …` site settings
  (company identification, ANPC/SOL links, invoice series — replace every
  placeholder before launch; `pnpm launch:check` refuses to pass while one
  stands) and the initial content bundles under `content/` (an existing slug
  is skipped and reported; `pnpm content import-dir --overwrite` replaces
  on purpose).
- **`pnpm seed:demo`** creates the three demo articles, the demo quiz and
  three demo products with SVG placeholder covers — create-only as well, so a
  re-run only recreates what was deleted and never resets stock, prices,
  status or text. Do not run it on production unless you want the demo
  content there; delete it in the admin when real content lands. It needs
  the media bucket (it uploads the covers).
- `pnpm db:seed` runs both halves — the local one-shot for a fresh database.
- **Upgrading an installation that was live before 2025-08-01** (FIX-18):
  migration 0024 turns the old single `invoice.vatRateBp` into a one-line
  standard-rate schedule dated `2025-08-01` carrying *that* rate — 19 % on
  an entity that never edited it — and issuance would use it for every later
  order. After `pnpm db:migrate`, open `/admin/settings` → Invoice, confirm
  the standard-rate schedule (one `YYYY-MM-DD percent` line per rate change;
  21 % standard since 2025-08-01 in Romania) and **save** the group. The form
  shows a warning under the field and `pnpm launch:check` reports the
  never-confirmed schedule as a problem until that save happens.
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

**Storage layout and the quarantine prefix (FIX-15).** The bucket holds three
kinds of key:

| prefix        | written by                         | served publicly |
| ------------- | ---------------------------------- | --------------- |
| `pending/`    | the browser's presigned PUT        | **never**       |
| `uploads/`    | `confirmUpload` (finalize)         | yes             |
| `seed/`       | `pnpm seed:demo` (finalize)        | yes             |

A presigned PUT lands in `pending/<uuid>.<ext>` and stays valid for 10
minutes. Confirm *produces* the served object from it — a server-side copy
into a fresh `uploads/…` key for rasters, a sanitized re-write with
`Content-Disposition: attachment` for SVGs, both with `Cache-Control:
public, max-age=31536000, immutable` — then deletes the pending object. The
presigned URL therefore never touches a served key: re-using it after
confirm only recreates an orphan under `pending/` (nothing serves it, nothing
reads it again). Content import and the seed write through the same finalize
step, so every served image in the bucket has been through the sanitizer.

The public origin MUST refuse `pending/`. Locally `pnpm storage:init` applies
a bucket policy with an explicit `Deny s3:GetObject` on `pending/*` next to
the public-read grant. On R2 the custom domain serves the whole bucket, so add
a Cloudflare **WAF custom rule** on the zone:

```
(http.host eq "media.bettersleep.ro" and starts_with(http.request.uri.path, "/pending/"))
→ Block
```

(one per site; put the rule above any cache rule). Optionally add an R2
**object lifecycle rule** deleting `pending/` objects older than one day, to
sweep abandoned uploads. Verify after deploy: a `curl -I
https://media.<site>/pending/x.png` must not answer 200 (a 403 or 404 both
mean the rule holds).

**Fiscal documents get their own bucket.** R2 public access is per bucket,
not per prefix, so anything in the media bucket is reachable through the
custom domain — invoice PDFs and e-Factura XMLs (name, address, email) must
not be there. Create a second bucket per site (e.g. `bettersleep-fiscal`),
give the SAME API token Object Read & Write on it, set
`S3_INVOICE_BUCKET=<bucket>`, and bind **no** public domain to it, ever.
`launch:check` refuses a `cloudflare` deploy without `S3_INVOICE_BUCKET`,
refuses `S3_INVOICE_BUCKET == S3_BUCKET`, and probes that
`${MEDIA_PUBLIC_BASE_URL}/invoices/…` does not answer 200. If the deploy
issued invoices before FIX-12 (documents under `invoices/` in the media
bucket), run `pnpm storage:fiscal-migrate` once with the site's env: it
moves every such object into the fiscal bucket (idempotent, never
overwrites a private copy) and leaves the media bucket with no `invoices/`
key. Locally `pnpm storage:init` creates both buckets (`<S3_BUCKET>-fiscal`
stays private).

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
upload**, once, rather than on every serve: the finalize step
(`finalizeMediaObject`, shared by confirm, content import and the seed)
strips scripts, event handlers, `<style>` blocks and every remote reference
(`href`, `url(http…)`, `@import`), writes the clean bytes as the served
object and sets `Content-Disposition: attachment` on it. The upload itself
sits in the unserved `pending/` prefix until then (§5), so no un-sanitized
SVG is ever reachable from the origin. Both layers matter — the sanitizer
removes the payload, the header means even a sanitizer miss downloads
instead of executing on the media origin. imgproxy's `IMGPROXY_SANITIZE_SVG`
stays on as a third layer on that target.

### `direct` — local only

Serves the stored original untouched. This is why `docker compose up -d`
brings up Postgres and MinIO only, and why the test suite needs no transformer:
there is nothing to run. srcsets come back empty and blurhashes are skipped
rather than faked, so what you see locally is honest about what it is.
`pnpm storage:init` grants the bucket anonymous read (minus `pending/`, §5)
so the browser can fetch originals; `pnpm media:blurhash` refuses to run on
this provider.

## 7. Stripe (shop)

Per site (separate Stripe accounts recommended so payouts/branding stay per
brand — a shared account also works):

1. Set `STRIPE_SECRET_KEY` (test key first: `sk_test_…`).
2. Dashboard → Developers → Webhooks → Add endpoint:
   `https://<site>/api/stripe/webhook`, subscribed to exactly these **four**
   events:
   - `checkout.session.completed` — creates the order (paid, or `pending`
     for a delayed payment method);
   - `checkout.session.async_payment_succeeded` — flips a pending order to
     paid (invoice, confirmation email, nurture);
   - `checkout.session.async_payment_failed` — marks it failed, restores the
     reserved stock, cancels fulfillment;
   - `charge.refunded` — partial (`amount_refunded < amount`): the order
     stays paid with the refunded amount recorded and the operator issues
     the storno from the order page ("storno parțial"); full: status
     refunded, storno, fulfillment/AWB handled.
   Stripe does not order deliveries; every handler is exactly-once in either
   arrival order (a refund before its order is remembered and applied when
   the order is created; an async result before its `completed` creates the
   order from the session it carries).
3. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Orders are created **only** by the webhook (idempotent on the session id);
   duplicate deliveries are acknowledged and ignored. Verify with a test-mode
   purchase (card `4242 4242 4242 4242`) before switching to live keys.
5. **Payment methods are card-only by default.** Sessions are created with
   `payment_method_types: ['card']` regardless of what the Stripe dashboard
   enables, so no delayed method (bank debit, voucher…) can put orders on the
   pending/async path by accident. To offer everything the dashboard enables,
   turn on `/admin/settings` → Magazin → "Permite toate metodele de plată";
   the two async events above are handled either way, but the decision is the
   operator's, not the dashboard's.
6. **The recipient phone is collected at Checkout** (`phone_number_collection`
   is on) and stored on the order's shipping address next to the county
   Stripe collects — the courier refuses an AWB without either. Orders placed
   before this existed, or whose Stripe address came without a county, are
   refused on the order page with the missing fields named; "Editează adresa"
   there fills them in (admin-only, the trail records which fields changed).

The product catalog syncs to Stripe on admin save (product + price objects);
checkout itself snapshots prices from our database, so an unsynced catalog
never blocks selling. Local/dev with an empty `STRIPE_SECRET_KEY` runs a
deterministic in-memory mock — never leave it empty in prod.

### Fiscal documents (invoice PDF + e-Factura XML)

Every issued invoice renders deterministically to a PDF and a UBL 2.1
(CIUS-RO 1.0.1) XML, stored write-once in the **private fiscal bucket**
(`S3_INVOICE_BUCKET`, §5 — never the media bucket, which the `cloudflare`
provider binds to a public domain) under renderer-versioned keys
(`invoices/<id>.<version>.<pdf|xml>`, so a renderer fix re-renders instead
of freezing a defective file). Nothing else to deploy: rendering is pure JS
inside the app (works on Vercel), the confirmation email attaches the PDF,
customers reach their documents through signed links on the order success
page, and `/admin/orders/export?month=YYYY-MM` gives the accountant a
monthly zip (CSV index with UTF-8 BOM and per-rate columns + all
PDFs/XMLs). `TOKEN_SECRET` (already required) signs the customer download
links.

**The SPV duty.** Transmitting every invoice to ANAF through e-Factura is
mandatory for this shop — B2B since 2024, B2C since 1 January 2025 — within
**5 calendar days of issuance**; late or missing transmission is fined per
document. It is therefore tracked, not left to memory: every invoice and
storno gets an `invoice_submissions` row at issuance, `/admin/orders` →
"De trimis la ANAF" lists what is still due with the calendar days left
(red when overdue), and the hourly `GET /api/cron/efactura-submit` (§9,
§12) renders the XML and pushes it through the `EFacturaSubmitter` seam
with retry/park semantics (5 attempts, then parked for a human).

**A parked document (FIX-17).** After 5 failed attempts the row is `failed`
and the cron never claims it again — but the 5-day clock keeps running. The
order page (`/admin/orders/<id>`) shows the failure under the document
("Trimiterea la ANAF a eșuat după N încercări: …") with a **"Repune în coada
ANAF"** button (admin-only, audited as `efactura-requeue`): the row goes
back to `pending` with the attempts reset and the next hourly tick submits
it. The same from a shell, e.g. after the fiscal bucket or the ANAF
credentials were fixed: `pnpm efactura:requeue -- --all` (every parked
document) or `pnpm efactura:requeue -- <invoiceId>`. Fix the cause first
(the error text is on the page and in `invoice_submissions.error`) —
re-queuing a document that will fail again only burns another 5 attempts.

**Automated submission is NOT implemented yet** — it requires enrollment
only a human can do. Until then the default submitter answers `skipped`
for every row (nothing is sent, nothing is faked, the row stays "de trimis")
and an operator uploads each XML (order page / monthly export) in the SPV
web interface **within the 5 days**, every working day. To enable automated
submission, a human must:

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

**CIUS-RO status** (details in `modules/invoice/README.md`): since FIX-12
the XML carries structured addresses (`CountrySubentity` as ISO 3166-2:RO,
`PostalZone`, `SECTORn` city names for București), one `TaxSubtotal` per
VAT rate, no buyer VAT identifier under category O, `OrderReference`,
payment reference and prepaid amounts for card payments, and the share
capital in the seller's legal-form field. It passes the repository's
offline validator and is byte-stable against two golden fixtures, but it
has **not** been run through ANAF's public validator from the build (no
live service is called): the LAUNCH-CHECKLIST carries that step, and the
first real SPV answers are the final acceptance.

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
4. **Verify with one real AWB**: pick a (test) paid order whose address has
   a phone and a county (the page refuses otherwise — see §7 "Stripe" 6),
   generate the AWB from `/admin/orders/[id]`, download the label, confirm
   the shipment appears in the eAWB dashboard with our order id as its
   client reference. Then cancel it IN eAWB (not from our side) and run the
   sync once by hand (§9 curl): the order must step back from `expediată` to
   `împachetată` with an "AWB anulat de curier" event and the page must
   offer a new AWB. Until this passes, treat the adapter as unverified.
5. **Capture the status payloads as fixtures** while that AWB exists — the
   status table is maintained from real answers, never from memory:

   ```bash
   TOKEN=$(curl -sS -X POST 'https://api.sameday.ro/api/authenticate?remember_me=1' \
     -H "X-Auth-Username: $SAMEDAY_USERNAME" -H "X-Auth-Password: $SAMEDAY_PASSWORD" | jq -r .token)
   curl -sS "https://api.sameday.ro/api/client/awb/<AWB>/status" -H "X-Auth-Token: $TOKEN" \
     > apps/web/tests/fixtures/sameday/status-<state>.json
   ```

   Save one file per state you observe (emis, ridicat / în tranzit, livrat,
   anulat, and any "nelivrat" attempt). Each `expeditionStatus.statusId` +
   text pair goes into `SAMEDAY_STATUS_BY_ID`
   (`apps/web/src/lib/modules/shop/sameday-courier.ts`), which ships seeded
   with id 1 = "AWB Emis" only: until the table is filled in, the anchored
   text rules (explicit negatives first — "nelivrat" is NOT "livrat") do the
   classifying, and any text they do not know is logged at warn level with
   the raw payload and mapped to "în tranzit". Treat every such log line as
   a fixture to capture and a table row to add.

**How an AWB is created (FIX-11).** Generation is two-phase: a `creating`
claim row is committed first, the courier is called with no database lock
held, then the row becomes `registered` (AWB, tracking link) or `failed`
with the courier's own reason (Sameday's validation text is shown on the
order page; "Reîncearcă AWB" starts over with a fresh claim). The AWB is
registered with `clientInternalReference` = our order id, so a process that
dies mid-call (the claim is failed and replaced after 5 minutes) leaves an
AWB you can find in eAWB by order id. A courier-side cancellation (seen by
the hourly sync) closes the row, moves the order back to `împachetată` and
allows a replacement; a refund landing while the courier is registering
cancels the fresh AWB again.

**Sync health.** The hourly sync (§9) answers
`{"polled":…,"updated":…,"errors":…}` plus `"aborted":"auth"` when the
courier rejected the credentials (the run stops at once and logs at error
level — fix `SAMEDAY_*` and re-run). A row whose lookup throws is retried
with backoff (15 min, doubling, capped at 24 h) instead of blocking the
batch, keeps `error_count` / `last_error` and writes a "shipment-sync-error"
event on its order; while any in-flight row has `error_count > 0` the admin
dashboard (`/admin`) shows a "sincronizarea eșuează" banner with the latest
error text. A successful poll clears the flag.

Until then `COURIER_PROVIDER=mock` keeps everything working end-to-end with
deterministic fake AWBs (dev/test default) — usable for staging, never for a
real customer parcel.

## 8. Email (Resend)

1. Add and verify the sending domain in Resend (SPF + DKIM DNS records).
2. Set `RESEND_API_KEY` and `EMAIL_DRYRUN=false`.
3. The sender identity (`from`/`replyTo`) comes from the site config
   (`apps/web/src/lib/config/sites/<site>.ts`) — `salut@bettersleep.ro` must
   be under the verified domain.

4. **Bounce/complaint webhook.** In Resend → Webhooks add an endpoint for
   `https://<site>/api/webhooks/resend` subscribed to `email.bounced` and
   `email.complained`, and set its signing secret (`whsec_…`) as
   `RESEND_WEBHOOK_SECRET`. The route verifies the Svix signature over the raw
   body (`svix-id`/`svix-timestamp`/`svix-signature`, ±5 min window) and
   withdraws the recipient exactly like an unsubscribe: every consent revoked
   (source `bounce`/`complaint`), double opt-in cleared, pending nurture
   cancelled. Without the secret the route answers `503` and nothing is fed
   back — set it before `EMAIL_DRYRUN=false`. Verify once with a test event
   from the Resend dashboard: the function log prints
   `resend-webhook kind=bounce recipients=1 revoked=0|1`.
5. **One-click unsubscribe headers.** Marketing mail (the `nurture` template)
   carries `List-Unsubscribe: <https://<site>/unsubscribe/<token>>` and
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058); Gmail and
   Yahoo require them for bulk senders. Mail clients POST to that URL; the
   same URL opened by a human shows a confirmation button (GET changes
   nothing — link scanners must not unsubscribe anyone). Check the headers on
   a delivered nurture email ("show original") before launch.

With `EMAIL_DRYRUN=true` (the default) every "send" is only recorded in the
`email_log` table — that is the correct state until DNS is verified. All
sends are idempotent (unique `idempotency_key`), so retries never double-send.
A dry-run record is NOT a delivery: once `EMAIL_DRYRUN=false` the same key
sends for real (the soak never burns a confirm/nurture key). A `sending` claim
older than 10 minutes (a function killed mid-send) is re-claimable. Resend
failures are classified — 429/5xx/network retry with backoff, any other 4xx
parks the send at once with Resend's body — and the nurture drain paces live
sends at ~2/s.

## 9. Cron entries

| Schedule | Command | Purpose |
| --- | --- | --- |
| daily, e.g. `15 3 * * *` | `pnpm chat:prune` (repo checkout with the site's env) | Deletes chat sessions older than 30 days (GDPR retention; messages cascade), sweeps expired rate-limit counter rows, and prunes webhook idempotency-ledger rows (`processed_events`) older than 90 days. |
| hourly, e.g. `7 * * * *` | `curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/shipment-sync` | Polls the courier for every DUE in-flight AWB (bounded batch per run, oldest-synced first), updates shipment + fulfillment state (`delivered`/`returned`; a courier-side `cancelled` steps the order back to packed) and appends order events. Safe to run twice; a pure no-op while nothing is in flight. A row whose lookup throws is backed off (15 min, doubling, 24 h cap) and flagged on `/admin`; the JSON answer carries `errors` and, on a credentials failure, `"aborted":"auth"` — alert on either (§7 "Sync health"). Runs through the app (it needs the courier adapter), so the machine-cron form IS the curl — set `CRON_SECRET` on adapter-node deployments too. |
| hourly, e.g. `37 * * * *` | `curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/efactura-submit` | Drains the e-Factura submission queue (§7): claims a bounded batch of due `invoice_submissions` rows (25/run, `FOR UPDATE SKIP LOCKED` — an overlapping run cannot double-submit), renders the XML into the fiscal bucket and submits through the `EFacturaSubmitter` seam. Failures retry with backoff (15 min doubling, 6 h cap) and park after 5 attempts (`failed`, shown in `/admin/orders` → "De trimis la ANAF"; re-queued from the order page or with `pnpm efactura:requeue`, §7). With no ANAF enrollment (the default no-op submitter) every row is `skipped` and re-checked hourly — the JSON answer then reads `{"claimed":n,"skipped":n,…}` and the manual SPV upload remains the operator's job. |
| every 15 min, e.g. `*/15 * * * *` | `curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/nurture-send` | Drains the nurture email queue: cancels due rows more than 48 h late as `stale` (a resumed pause never floods the missed steps), claims a bounded batch of due sends (25/run), sends them grouped per enrollment in step order, re-checks the marketing consent per send, mails through the idempotent email wrapper (~500 ms between live sends), retries transient failures with backoff and parks them after 5 attempts — permanent Resend errors (4xx other than 429) park at once. Parked sends stay visible in `/admin/nurture` with a **retry** button; their enrollment stays active until then. Concurrency-safe (`FOR UPDATE SKIP LOCKED` claim), so an overlapping run cannot double-send. A no-op while nothing is due — and while `EMAIL_DRYRUN` is unset it only records to `email_log`. The JSON answer carries `stale`; alert when `parked` > 0. Design notes: `src/lib/modules/nurture/README.md`. |

Where no machine can run scripts (Vercel), the retention job is also
available over HTTP at `GET /api/cron/chat-prune` — see §12. Both forms call
`runRetentionSweep()` in `src/lib/server/retention.ts`, so they cannot drift
apart (the sweep also expires closed nurture enrollments after 180 days). On
Vercel all four routes are scheduled by `apps/web/vercel.json`.

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

1. `curl https://<site>/api/health` → `200 {"status":"ok","site":"sleep","commit":"<sha>",…}`
   (liveness: the build you expect) and `curl https://<site>/api/health/ready`
   → `200 {"status":"ok","checks":{"db":"ok","storage":"ok"},…}` (readiness).
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
| `CRON_SECRET` | `openssl rand -hex 32` | Guards the four cron routes below. Vercel Cron sends it as `Authorization: Bearer …` automatically. |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `15000` | A suspended Neon compute takes seconds to wake; the 5 s default sheds the first request after an idle period as a pool timeout. |
| `ERROR_REPORT_URL` | optional | Sink for the structured error lines (posted via `waitUntil` after the response). `launch:check` warns when unset; a Vercel log drain is the alternative. |
| `ADDRESS_HEADER`, `XFF_DEPTH` | **leave unset** | Vercel resolves the client IP itself. Setting them here would let a caller spoof `getClientAddress()` and defeat every rate limit. |
| `NODE_ENV` | **leave unset** | Vercel sets it for the build and the runtime. Setting `production` in the project env breaks the root `prepare` (formcomp's devDependencies are skipped and the build cannot resolve `formcomp`). |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | Makes Vercel honor `packageManager` (pnpm 11.10.0) instead of a pnpm derived from the lockfile version. |

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
- **Build Command**: `pnpm db:status && pnpm build` — belt and braces: a
  build ahead of the schema (a migration still pending on the target database)
  refuses to build instead of shipping code that 500s until the migration
  lands (`scripts/migrate-status.ts` exits non-zero while anything is
  pending). The adapter switches itself: Vercel sets `VERCEL=1`;
  `vite.config.ts` picks `adapter-vercel`, otherwise `adapter-node`.
- **Output**: `.vercel/output` (detected automatically)
- **Node version**: 22.x — the same `.node-version` CI uses and the `runtime`
  the adapter requests (the Neon driver needs a global `WebSocket`; root
  `package.json` `engines` allows `>=22.18 <23 || >=24`).
- **Git → Production Branch**: `main`, and **Automatic deployments for the
  production branch: OFF** — production is promoted by the `deploy` job in
  `.github/workflows/ci.yml` AFTER the migration job (below). Keep preview
  deployments ON for pull requests.
- **Preview environment**: its `DATABASE_URL`/`DIRECT_DATABASE_URL` point at a
  **Neon branch** (Neon → Branches → create from `main`; or the Neon–Vercel
  integration's per-preview branches), never at the production database.
  Set `EMAIL_DRYRUN=true`, mock chat/courier and a test Stripe key there.

`apps/web/vercel.json` ships the cron schedule. `/api/chat`, the four cron
routes (`chat-prune`, `shipment-sync`, `nurture-send`, `efactura-submit`) and
the Stripe webhook declare `maxDuration = 60` in their `+server.ts`: the
assistant streams its reply, a cron batch makes one provider round trip per
row (the nurture drain also paces live sends at ~500 ms), and a paid Stripe
session issues the invoice and awaits the confirmation email inline — all of
them would be cut off at the 10 s plan default. 60 s is the ceiling every
Vercel plan allows, so the export is plan-independent. **Plan requirement:**
Vercel's Hobby plan runs cron jobs at most **once per day** (and not at a
guaranteed minute) — the 15-minute nurture drain and the hourly shipment/
e-Factura polls need the **Pro** plan (or an external scheduler curling the
routes with the bearer, §9). On Hobby the schedules in `vercel.json` are
silently coalesced to daily.

### Ordered deploy (GitHub Actions: gate → migrate → deploy)

Migrations do **not** run during the build — a build is not a deploy, and
Vercel may run several concurrently — and production is **not** promoted by
Vercel's Git integration, because nothing would order that promotion after
the migration. `.github/workflows/ci.yml` does both, in order, per site:

| Job | When | What |
| --- | --- | --- |
| `gate` | every PR and push | Postgres 16 + MinIO; lint → check → `db:migrate` on a fresh database → `db:check` → `test:unit` → both builds → `launch:check --target=vercel` against a prod-shaped env. |
| `e2e` | PRs, non-blocking | `pnpm test:e2e` (report uploaded as an artifact). |
| `migrate` | `main` only, `needs: gate`, environment `production` | One matrix entry per site in `deploy/sites.json`; `pnpm install --ignore-scripts --filter web`; `pnpm db:migrate` (advisory lock, SQL files, concurrent indexes); `pnpm db:role-timeout`; `pnpm db:status` printed. Fails closed without the site's secret. Never seeds. |
| `deploy` | `needs: migrate`, per site | `vercel pull --environment=production` → `vercel build --prod` → `vercel deploy --prebuilt --prod`. |

Wire it once (a human):

1. **GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   `VERCEL_TOKEN` (a Vercel account token), `VERCEL_ORG_ID` (team id), and
   per site the names `deploy/sites.json` declares — for better-sleep
   `DIRECT_DATABASE_URL_SLEEP` (the **unpooled** Neon URL,
   `postgres://…neon.tech/better_sleep?sslmode=require`, not the `-pooler`
   host: DDL and session locks through PgBouncer are unreliable) and
   `VERCEL_PROJECT_ID_SLEEP` (project → Settings → General).
2. **GitHub environment** `production` (repo → Settings → Environments):
   create it; optionally require a reviewer — then every migrate/deploy waits
   for a click.
3. **Branch protection** on `main`: require the `ci / gate` status check and
   a linear history; pushes to `main` that skip the gate cannot deploy.
4. **Vercel project**: automatic production deploys OFF (Settings → Git);
   Build Command `pnpm db:status && pnpm build` (above); Node 22.x;
   `ENABLE_EXPERIMENTAL_COREPACK=1`; no `NODE_ENV` in the env.
5. **Watch the first run** end to end (Actions → ci → the push to `main`):
   gate green → migrate prints the applied list → deploy prints the
   production URL → `curl /api/health` shows the new commit. The sandbox that
   built this cannot observe GitHub, so this run is the first real proof.

Adding better-life: one more entry in `deploy/sites.json` (`id`, the two
secret names, its media and fiscal bucket names) plus those secrets. The
matrix, the backup workflow and the concurrency groups follow from the file.

**Neon role timeout.** The app's per-connection `SET statement_timeout` is
not a session guarantee behind Neon's PgBouncer. The migrate job runs
`pnpm db:role-timeout` (`ALTER ROLE current_user SET statement_timeout =
'30s'`, idempotent, only the role it connects as); run it yourself once
after creating the project, and again if you rotate the role.

`pnpm db:status` is runnable from any checkout (non-zero while migrations
are pending); `pnpm db:migrate` from a checkout is safe alongside CI — both
take the same advisory lock (`docs/MIGRATIONS.md`).

### Deploy order

First deploy only — run the one-off setup yourself from a checkout, with the
site's Neon URLs exported (later deploys need none of this; the workflow
keeps the schema current):

```bash
# from a checkout, with the site's Neon URLs exported:
DIRECT_DATABASE_URL="postgres://…neon.tech/better_sleep?sslmode=require" pnpm db:migrate
DIRECT_DATABASE_URL="postgres://…neon.tech/better_sleep?sslmode=require" pnpm db:role-timeout
DATABASE_URL="…-pooler…" S3_ENDPOINT=… S3_BUCKET=… pnpm seed:base      # pillars, pages, settings, initial content
DATABASE_URL="…-pooler…" pnpm media:blurhash                           # placeholders for imported media
DATABASE_URL="…-pooler…" pnpm user:create -- --email you@x.ro --role admin   # prompts for the password
```

`pnpm seed:base` imports the initial content bundles (`content/common`,
`content/<site>`), so it needs the R2 credentials too. It is safe to re-run
on later deploys: pillars and nurture definitions are upserted, everything
else is create-only — an admin's edits to pages, settings or imported
content are never reverted (an existing slug is skipped; `pnpm content
import-dir --overwrite` replaces deliberately). `pnpm content:init` re-runs
just the content step. `pnpm seed:demo` (demo articles/quiz/products) is for
dev and staging — do not run it against production (§4).

### Scheduled jobs

`vercel.json` schedules `GET /api/cron/chat-prune` daily (retention),
`GET /api/cron/shipment-sync` hourly (courier tracking poll — §9),
`GET /api/cron/nurture-send` every 15 minutes (nurture email queue — §9)
and `GET /api/cron/efactura-submit` hourly (e-Factura submission queue —
§7, §9). All routes require `Authorization: Bearer $CRON_SECRET`; without
`CRON_SECRET` set they answer `503` rather than running unauthenticated.
Verify once by hand:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/chat-prune
# {"sessions":0,"chatRateLimitRows":0,…,"retentionDays":30}
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/shipment-sync
# {"polled":0,"updated":0,"errors":0}
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/nurture-send
# {"claimed":0,"sent":0,"retried":0,"parked":0,"cancelled":0,"stale":0,"completed":0}
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/efactura-submit
# {"claimed":0,"submitted":0,"skipped":0,"retried":0,"parked":0}
```

### Verification

§11 applies unchanged. Two additions worth doing on the first serverless
deploy, because they exercise what this target actually changes:

1. `/api/health/ready` → `{"status":"ok","checks":{"db":"ok","storage":"ok"},…}`
   proves the Neon driver and R2 from inside a function; `/api/health`
   names the commit that is live.
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

### Locale policy (FIX-15)

Both sites are **single-locale (`ro`)**: `locales: ['ro']` in the site
config is the source of truth for the subscriber locale and for `hreflang`
alternates — and with one locale no alternates are emitted at all. Paraglide
still compiles `messages/en.json` (a parity test keeps its keys equal to
`ro.json`) but its runtime strategy is `cookie, globalVariable, baseLocale`
without `url`, so `/en/…` is NOT a localized page and must never be
advertised. To ship a second locale: add it to the site's `locales`, add
`"url"` to the paraglide strategy (`vite.config.ts`) so the locale is
resolved from the path and canonicals become self-referential per locale,
and localize the content — `hreflangAlternates` (`src/lib/seo.ts`) starts
emitting alternates only once BOTH hold.

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
