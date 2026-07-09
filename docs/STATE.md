# STATE — after Phase 3 (Blog)

## What exists

- **pnpm workspace**: `apps/web` (SvelteKit 2, Svelte 5 runes, TS strict, Tailwind v4,
  Paraglide with base locale `ro` + `en`, adapter-node) and `packages/formcomp`
  (vendored quiz form library, consumed as `formcomp` workspace dep; its `dist/` is
  built by the root `prepare` script on `pnpm install`).
- **Site config system** (`apps/web/src/lib/config/`):
  - `pillars.ts` — the 9 canonical pillars (ro slugs: `somn`, `nutritie`, `miscare`,
    `stres`, `relatii`, `scop`, `mediu`, `minte`, `finante`).
  - `sites/sleep.ts` (1 pillar) and `sites/life.ts` (9 pillars) — the ONLY places a
    brand string may appear. Shape: `{ id, name, domain, locales, pillars, theme, nav,
    chatPersonaKey, email }`.
  - `index.ts` — pure `resolveSiteConfig(siteId)` (throws on missing/unknown id or
    non-canonical pillar). Server code gets the active config via
    `getSite()` from `$lib/server/site` (reads `SITE_ID` from `$env/dynamic/private`,
    memoized per process).
- **Compose stack** (root `docker-compose.yml`): `db` (Postgres 16, host port
  `${DB_PORT:-5433}`; 5432 was taken on this host), `minio` (S3 API on
  `${MINIO_PORT:-9000}`, console on `${MINIO_CONSOLE_PORT:-9001}`) and `imgproxy`
  (host port `${IMGPROXY_PORT:-8888}`, signature required, reads sources from
  `s3://…` via `http://minio:9000` inside the compose network). All dev
  credentials/keys have compose defaults matching `.env.example`.
- **Database**: Postgres 16 (service `db` above). A fresh volume auto-creates
  `better_sleep`, `better_life`, `better_test` (see `docker/postgres-init/`).
  Drizzle: schema barrel `apps/web/src/lib/db/schema/index.ts` (composes future module
  schemas; core has `pillars`), client factory in `db/client.ts`, lazy app client
  `getDb()` in `db/index.ts`. Migrations committed under `apps/web/drizzle/`.
- **Seed**: `pnpm db:seed` upserts the active site's pillars (idempotent);
  logic in `src/lib/db/seed.ts`, entry `scripts/seed.ts` (plain `node`, Node 24 type
  stripping — keep script imports relative with explicit `.ts` extensions).
- **Modules**: `src/lib/modules/{blog,quiz,shop,chat,email,media,auth}/` with barrel
  `index.ts` each. ESLint `no-restricted-imports` forbids importing
  `$lib/modules/<name>/<anything deeper>` — cross-module imports go through the barrel,
  within a module use relative imports.
- **Public skeleton**: config-driven root layout (site name, nav, theme tokens emitted
  as CSS vars `--color-*` on a wrapper div), homepage listing active pillars
  (`data-testid="pillar-item"`), `/sanatate/[pillar]` landing (404 for inactive/unknown
  pillars), `+error.svelte`, `/dev/form` proving formcomp integration.

## Auth & admin (Phase 1)

- **modules/auth** (`apps/web/src/lib/modules/auth/`): better-auth 1.6 with the
  Drizzle adapter (`usePlural: true` — tables `users`, `sessions`, `accounts`,
  `verifications`). Email+password only, **public signup disabled**, password min
  length 12. `users.role` is a better-auth additionalField: `'admin' | 'editor'`
  (default `editor`, `input: false` so it can never come from a request).
  - `auth.ts` — framework-free `createAuth({ db, secret, baseURL, plugins })`
    factory (no `$env`/`$app` imports) used by the CLI, tests and e2e setup.
  - `server.ts` — lazy `getAuth()` for the app: reads `BETTER_AUTH_SECRET` +
    `PUBLIC_SITE_URL`, wires the `sveltekitCookies` plugin so `auth.api` calls in
    form actions set cookies. Session cookie: httpOnly, SameSite=lax; Secure is
    derived by better-auth from an https `PUBLIC_SITE_URL` (so secure in prod).
  - `guards.ts` — pure `guardAdminPath(pathname, role)` →
    allow / login-redirect / forbidden. `ADMIN_ONLY_SECTIONS = products, orders,
    subscribers, settings` (editors are blocked there; everything else under
    /admin needs any staff session).
  - `rate-limit.ts` — login rate limit, 5 failed attempts / 15 min per IP+email,
    fixed window persisted in `login_attempts` (pure logic + Db helpers).
  - `staff.ts` — `upsertStaffUser(auth, { email, password, role })`: idempotent
    on email (creates user + credential account, or updates role/password via
    better-auth's internal adapter, hashing included).
- **Creating users**: `pnpm user:create -- --email a@b.ro --password 'min12chars…'
  --role admin|editor [--name X]` (root script → `apps/web/scripts/user-create.ts`,
  plain node against `DATABASE_URL`; needs `BETTER_AUTH_SECRET`). Idempotent:
  rerunning with the same email updates role+password.
- **Auth flow**: `/admin/login` form action calls `auth.api.signInEmail` (rate
  limit checked first; failures recorded; success clears the counter) →
  redirect to `/admin`. Logout is a POST action at `/admin/logout` →
  `auth.api.signOut` → back to login. There is NO `/api/auth/*` catch-all —
  all auth goes through form actions.
- **Guarding**: `hooks.server.ts` (`handleAdminGuard`, after paraglide in the
  sequence) resolves the session ONLY for `/admin*` paths, fills
  `event.locals.user` (`{ id, email, name, role }` — typed in `app.d.ts`), then
  enforces `guardAdminPath`: anonymous → 303 `/admin/login`; editor on an
  admin-only section → 403. Role checks are server-side; the sidebar also
  filters entries per role (cosmetic).
- **Routes layout**: public pages moved into `src/routes/(public)/` (URLs
  unchanged; note route ids now include the group — e.g.
  `resolve('/(public)/sanatate/[pillar]', …)`). Root `+layout.svelte` keeps only
  theme/css; the public header lives in `(public)/+layout.svelte`. Admin shell:
  `admin/(shell)/+layout.svelte` (sidebar `data-testid="admin-sidebar"`, header
  with site name + user + logout) with dashboard (placeholder stat cards) and
  stub pages: media→phase 2, articles→3, quizzes/subscribers→4,
  products/orders→5, settings→7. `admin/login` sits outside the shell group.

## Media (Phase 2)

- **modules/media** (`apps/web/src/lib/modules/media/`), with TWO barrels — this
  phase introduced the pattern (ESLint now allows both):
  - `$lib/modules/media` (universal): the `<Img>` component, upload validation
    (`ALLOWED_IMAGE_MIMES` jpeg/png/webp/avif/gif/svg, `MAX_UPLOAD_BYTES` 15 MB,
    `validateUpload`, `mediaKeyFor`) and types only.
  - `$lib/modules/media/server` (server-only): everything that signs or touches
    storage/db — importing it from client code fails the build by design, because
    `IMGPROXY_KEY`/`IMGPROXY_SALT` and S3 credentials must never reach the browser.
- **Schema**: `media` table (migration `0002`) — text id (uuid), `kind`
  `image | video-embed`, `key` (unique storage path, null for video), filename,
  mime, size, width, height, `alt` (not null, default ''), `blurhash` (nullable,
  NOT populated yet — computing it needs pixel decoding, deferred), video
  provider (`youtube | bunny`) + external id, created_by → users, created_at.
  A check constraint enforces the image/video column shape.
- **URL building** (`imgproxy.ts`, pure): `signImgproxyPath` (HMAC-SHA256 over
  salt+path, base64url), `buildImgUrl(cfg, key, {w,h,fit,format,dpr})`,
  `buildSrcset` (1x/2x), `imageSources(cfg, row|key, {w,h,fit})` → serializable
  `ImageSources`. Server-bound shortcuts in the server barrel: `imgUrl()`,
  `imgSources()`. SVGs are emitted unresized/unconverted. The unit test vector
  was validated against the live imgproxy container.
- **Upload flow**: browser → `POST /admin/media/upload` `{op:'presign',
  filename, mime, size}` (validates, returns `{key, uploadUrl}`) → browser PUTs
  the file straight to storage (presigned URL signs content-type AND
  content-length — a mismatching PUT gets 403 from storage; see
  `signableHeaders` in `storage.ts`) → `{op:'confirm', key, filename}` verifies
  the object exists, re-validates its real size/mime, reads width/height
  server-side (`image-size`) and inserts the row.
- **`<Img>`** (`Img.svelte`): takes a server-built `ImageSources` (`image` prop),
  renders `<picture>` with avif+webp 1x/2x srcsets and lazy `<img>`; alt comes
  from the row or the `alt` prop; empty alt without `decorative` logs a dev
  warning. URLs are signed ONLY in `load`/endpoints — components never see keys.
- **Admin library** (`/admin/media`, editor-accessible): drag&drop/click upload
  (multiple files), thumbnail grid via imgproxy, inline alt editing
  (`?/updateAlt`), delete (`?/delete` — removes object + row). Deletion is
  refused with 409 while any registered reference check claims the row:
  `registerMediaReferenceCheck({name, isReferenced})` from the server barrel —
  content modules of later phases MUST register one per media-referencing table.
- **Video embeds**: schema + `createVideoEmbed()` service exist and the library
  grid renders such rows as a provider/id card; there is no admin UI to add
  them yet (do it in the phase that first embeds video into content).
- **Storage** (`storage.ts`): `createStorage(cfg)` wraps the AWS SDK v3 client
  (`forcePathStyle: true`). NO MinIO-specific code paths anywhere — switching to
  Cloudflare R2 is purely `S3_*` env var changes (verified by reading the code:
  endpoint/creds/bucket/region all come from config; `ensureBucket` is only used
  by bootstrap/tests, R2 buckets can pre-exist).
- **Bootstrap**: `docker compose up -d` then `pnpm storage:init` (idempotent
  bucket creation; the e2e global-setup also ensures the bucket, and the fresh
  stack path — volume wiped, `up -d`, `storage:init`, full integration run —
  was exercised in this phase).

## Blog (Phase 3)

- **modules/blog** (`apps/web/src/lib/modules/blog/`), split barrels like media:
  - `$lib/modules/blog` (universal): `slugify`/`nextUniqueSlug` (ro-diacritics
    transliteration incl. legacy cedilla ş/ţ; suffix `-2`, `-3`, … on collision),
    `extractMediaRefs`, `ArticleRow` types.
  - `$lib/modules/blog/server`: services + rendering; importing it ALSO registers
    the articles media-reference check (module init side effect). It is imported
    for that side effect in `hooks.server.ts`, so the check is live before any
    request can hit the media library's delete action.
- **Schema** (migration `0003`): `articles` — text id (uuid), unique `slug`,
  title, excerpt, `body_md`, `cover_media_id` FK→media (set null), status
  `draft|published`, `published_at`, `seo_title`, `seo_description`,
  created_by→users, timestamps; `article_pillars` (article_id, pillar_id, PK on
  both, cascade). No site column anywhere — visibility is pillar tagging.
- **Services** (`service.ts`, framework-free `{ db }` deps, `BlogResult<T>`):
  `createArticle` (auto unique slug from title), `updateArticle` (patch incl.
  slug normalize+dedupe — an explicitly taken slug gets suffixed, re-saving your
  own doesn't; `pillarSlugs` replaces join rows, unknown slug → error),
  `publishArticle` (stamps `publishedAt` ONCE — republishing keeps the original
  date), `unpublishArticle`, `getArticle`, `getBySlug` (drafts only with
  `includeDrafts`), `listPublished({pillarSlugs, page, pageSize=9})` (published
  AND tagged to ≥1 given slug; empty list → nothing), `listArticles`
  (admin: status filter + ilike search), `listPublishedForSitemap`.
- **Markdown pipeline** (`markdown.ts` pure + `render.ts` db glue): marked with a
  custom image renderer + sanitize-html allowlist over the OUTPUT (scripts,
  event handlers, `javascript:` URLs, iframes to unknown hosts always stripped;
  src-less iframe shells dropped). `![alt](media:<id-or-key>)` resolves via
  `renderArticleHtml(deps, imgproxyCfg, bodyMd)` to `<picture>` markup
  (avif/webp 1x/2x through imgproxy, w=768) or, for `video-embed` rows, an
  iframe (youtube-nocookie / iframe.mediadelivery.net; external id validated
  against `[A-Za-z0-9_/-]`). Unresolved refs render as nothing.
- **Admin** `/admin/articles` (editor-accessible): create-by-title form → editor
  at `/admin/articles/[id]`; list has status filter + search. Editor: title
  (auto-suggests slug until slug manually edited — server dedupes on save),
  slug, excerpt, markdown textarea with server-rendered preview toggle
  (`?/preview` action), cover picker + inline-image inserter from the media
  library (`MediaPicker.svelte`), pillar checkboxes (site's active pillars
  only), SEO fields, save/publish/unpublish (publish/unpublish also persist the
  form first).
- **Public**: `/blog` (paginated cards, `?page=`), `/blog/[slug]` (drafts 404),
  pillar landing pages list that pillar's latest 6. Site nav configs gained a
  `Blog` entry.
- **SEO**: shared `src/lib/components/Seo.svelte` (title, description, canonical,
  OG, twitter card, optional JSON-LD — assembled with escaped `<` via
  `jsonLdString`) + `src/lib/seo.ts` `canonicalUrl(path)` from `PUBLIC_SITE_URL`.
  Article pages emit JSON-LD `Article` and a fixed-size 1200×630 jpg OG image
  through imgproxy. `sitemap.xml` (static pages + active pillar pages +
  site-visible published articles) and `robots.txt` (disallow /admin, sitemap
  URL) are dynamic routes — the old `static/robots.txt` was REMOVED, don't
  re-add it (it would shadow the route in the build output).
- **Seed**: `pnpm db:seed` also upserts 3 published ro demo articles tagged
  `somn` (fixed ids, upsert-by-slug, idempotent).
- **Typography**: `@tailwindcss/typography` is installed (`@plugin` in
  `routes/layout.css`); rendered article HTML gets `prose` classes.

## Key commands (all from repo root)

- `docker compose up -d` — start Postgres + MinIO + imgproxy (`--wait` works, all
  have healthchecks).
- `pnpm storage:init` — create the media bucket (idempotent).
- `pnpm dev` / `pnpm build` — dev server / production build (adapter-node).
- `pnpm lint && pnpm check && pnpm test:unit` — the phase gate; all green.
- `pnpm test:e2e` — needs the full compose stack up; builds, then runs playwright
  against two preview servers
  (port 4173 = `SITE_ID=sleep`, 4174 = `SITE_ID=life`); one build serves both because
  `SITE_ID` is read at runtime.
- `pnpm user:create -- --email … --password … --role admin|editor` — create/update
  a staff user in the `DATABASE_URL` database.
- `pnpm db:migrate` / `pnpm db:seed` — for the site in `.env`; for the other site
  prefix e.g. `SITE_ID=life DATABASE_URL=postgres://better:better@host.docker.internal:5433/better_life`.
- `pnpm --filter web db:generate` — generate a new migration after schema changes.

## Env & environment quirks

- `.env` lives at the **repo root** (see `.env.example`): `SITE_ID`, `DATABASE_URL`,
  `TEST_DATABASE_URL`, `PUBLIC_SITE_URL`, `DB_PORT`, `BETTER_AUTH_SECRET` (new in
  Phase 1 — better-auth session secret; generate a real one outside dev). It is loaded by `vite.config.ts`
  (dotenv, never overrides real env), `drizzle.config.ts`, `scripts/seed.ts`, and the
  vitest setup file. In this agent container all service hosts are
  `host.docker.internal` (compose containers are siblings); `.env.example`
  documents `localhost` for humans.
- Phase 2 env vars: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
  (`better-base-media`), `S3_REGION`, `IMGPROXY_URL`, `IMGPROXY_KEY`,
  `IMGPROXY_SALT`, plus compose port knobs `MINIO_PORT`, `MINIO_CONSOLE_PORT`,
  `IMGPROXY_PORT`. **Reachability rule**: `S3_ENDPOINT` and `IMGPROXY_URL` must be
  reachable by BOTH the server process and the browser (presigned PUTs and <img>
  fetches go directly from the browser). In this container that is
  `host.docker.internal:9000/8888` for both, because the app/vitest/playwright's
  chromium all run in the agent container while minio/imgproxy are siblings with
  host-published ports; on a human host machine `localhost:9000/8888` serves both
  roles. A prod split (internal S3 endpoint + public imgproxy domain) would need
  separate vars — not needed yet.
- Host port **5433** for Postgres (5432 is occupied by an unrelated container on this
  host). Container port stays 5432.
- **Playwright in this container**: chromium's system libraries were installed
  rootless — debs extracted to `~/chromium-libs`. Before `pnpm test:e2e`, export
  `LD_LIBRARY_PATH=$HOME/chromium-libs/usr/lib/x86_64-linux-gnu:$HOME/chromium-libs/lib/x86_64-linux-gnu`.
  (On a normal machine `npx playwright install-deps` replaces this.)
- Paraglide output (`src/lib/paraglide/`) is gitignored and regenerated; `pnpm check`
  runs `paraglide:compile` first so it works from a fresh checkout.

## Tests so far

- Unit: config resolver + canonical pillar invariants (`src/lib/config/config.spec.ts`).
- Integration: seed idempotency against `TEST_DATABASE_URL` (`src/lib/db/seed.spec.ts`)
  — drops `public`/`drizzle` schemas and re-migrates fresh each run; requires the
  compose db to be up.
- Unit: role guard decisions (`modules/auth/guards.spec.ts`), rate-limit window
  logic (`modules/auth/rate-limit.spec.ts`).
- Integration (`modules/auth/auth.spec.ts`, TEST_DATABASE_URL, fresh migrate):
  user upsert idempotency, session row on valid login / none on invalid, signup
  rejected. Vitest server project runs with `fileParallelism: false` because
  integration specs reset the shared test database.
- E2E smoke (`e2e/smoke.e2e.ts`): both SITE_IDs — site name in header, exact pillar
  count, active pillar page 200, unknown/inactive pillar 404.
- Unit: imgproxy signing/URL building (`modules/media/imgproxy.spec.ts` — the
  known-signature vector was verified live against the container) and upload
  validation/key slugging (`modules/media/validation.spec.ts`).
- Integration (`modules/media/media.spec.ts`, needs db+minio+imgproxy up):
  presign → PUT fixture (320×200 png from `tests/fixtures/`) → confirm records
  dimensions; wrong-content-type PUT 403s; signed imgproxy URL → 200
  `image/webp`, unsigned/tampered → 403; alt update; reference-check refusal;
  delete removes row + object; video-embed rows.
- E2E media (`e2e/media.e2e.ts`, both SITE_IDs): upload via the library, thumbnail
  actually renders (naturalWidth > 0, i.e. signed imgproxy URL served bytes to a
  real browser), alt edit survives reload, delete removes the card. Global setup
  also creates the bucket and clears the `media` table.
- E2E admin (`e2e/admin.e2e.ts`, both SITE_IDs): anonymous redirect, wrong
  password ×5 then 6th rate-limited, admin login→dashboard→logout, editor 403 on
  admin-only routes. `e2e/global-setup.ts` migrates BOTH site DBs, seeds
  e2e-admin/e2e-editor users and clears `login_attempts`;
  `playwright.config.ts` now injects a per-site `DATABASE_URL` into each preview
  server (derived from the root .env URL by swapping the db name).
- Unit (blog): slug transliteration/collision (`modules/blog/slug.spec.ts`),
  sanitizer XSS vectors + media-ref rendering (`modules/blog/markdown.spec.ts`).
- Integration (`modules/blog/blog.spec.ts`, TEST_DATABASE_URL, fresh migrate,
  all 9 pillars seeded): db slug dedupe, publish lifecycle (publishedAt stamped
  once, drafts invisible via `getBySlug`), pillar visibility against the REAL
  sleep/life config pillar lists (somn-tagged visible on both; nutritie-tagged
  invisible on sleep; untagged invisible everywhere — the SITE_ID=life DoD
  case), pagination, admin search, sitemap listing, `renderArticleHtml` by
  id/key + video rows, media reference check (cover + body refs).
- Integration (seed): `seedDemoArticles` idempotency in `db/seed.spec.ts`.
- E2E blog (`e2e/blog.e2e.ts`, both SITE_IDs): editor uploads a cover
  (own fixture `blog-cover.png` — media.e2e runs in parallel on the same
  library, filenames must not collide), creates/fills/tags an article, preview
  renders, draft 404s publicly and is absent from the sitemap, publish → card
  with real imgproxy-rendered cover on /blog, article page renders body +
  inline image, SEO assertions (title/description/canonical/og:type/og:image/
  twitter card/JSON-LD Article), sitemap entry, pillar landing card, unpublish
  → 404 again. Global setup now clears `articles` before `media`.

## For the next phase

- Admin screens land under `src/routes/admin/(shell)/<section>/` — replace the
  stub `+page.svelte` (they render `StubPage.svelte`; remaining stubs: quizzes,
  subscribers, products, orders, settings). The sidebar entry already exists;
  nav labels are paraglide messages (`admin_nav_*`). The articles section is a
  full reference implementation (list + editor + form actions).
- To show an image: build `imgSources(row, { w })` in a `load` function
  (server barrel) and pass it to `<Img>` (universal barrel). Never import the
  server barrel from a component.
- Any table that references `media.id` must register a
  `registerMediaReferenceCheck` at module init (see the integration spec for the
  shape) so the library's delete button starts refusing correctly.
- Module barrels: if your module needs $env/db-touching exports AND
  component/client exports, split them `index.ts` + `server.ts` like media does
  (ESLint allows `$lib/modules/<name>/server`).
- New admin-only sections must be added to `ADMIN_ONLY_SECTIONS` in
  `modules/auth/guards.ts`; everything else under /admin is editor-accessible by
  default.
- `locals.user` is available in all /admin server code (never null inside the
  shell). Add module schemas to the barrel as before — auth did:
  `export * from '../../modules/auth/schema.ts';`.

## Previously noted

- formcomp warns about `import.meta.env` usage during packaging (harmless under Vite,
  noted for a future minimal fix if it bites).
- `pnpm build` output: `apps/web/build/` (node server); previews use `vite preview`.
