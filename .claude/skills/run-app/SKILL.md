---
name: run-app
description: Launch and drive the better-base app locally (start, run, serve, or screenshot the site end-to-end on the host). Brings up Postgres/MinIO/imgproxy, migrates, seeds, builds, and serves in one command, then drives the funnel.
---

# Running better-base locally

One command brings the whole app up on the host:

```bash
bash scripts/dev-run.sh
```

It starts the compose stack (Postgres, MinIO, imgproxy), runs migrations + storage
init + seed, builds, launches the adapter-node server, waits for `200`, and prints
the URL (default **http://localhost:4173**, `SITE_ID=sleep`). Re-runnable; idempotent.

Variants:

```bash
SITE_ID=life bash scripts/dev-run.sh                       # 9-pillar site, DB better_life
PORT=4300 bash scripts/dev-run.sh                          # different port
SKIP_BUILD=1 bash scripts/dev-run.sh                       # reuse existing build (faster)
ADMIN_EMAIL=you@ex.ro ADMIN_PASSWORD='min12chars…' bash scripts/dev-run.sh   # create admin
```

Stop it:

```bash
bash scripts/dev-stop.sh          # app server only (compose stays up)
bash scripts/dev-stop.sh --all    # also `docker compose down`
```

Server log: `.run/app.log`. PID: `.run/app.pid`.

## Why a script and not raw commands (do not "simplify" these away)

These are the traps that cost time before the script existed — the script handles all
of them, but if you run steps by hand, honor them:

- **Host networking ≠ container networking.** The committed `.env` targets the
  phase-runner container (`host.docker.internal`), which does not resolve on the host.
  The script forces `localhost` for `DATABASE_URL`/`S3_ENDPOINT`/`IMGPROXY_URL`
  **without editing `.env`**. Never point the host app at `host.docker.internal`.
- **The adapter-node build does NOT load `.env` at runtime.** `dotenv` only covers the
  `pnpm` scripts (migrate/seed). The server process needs every var *exported*, which
  the script does. Launching `node build/index.js` with a bare shell → `SITE_ID is not
  set` 500s.
- **CSRF/origin.** SvelteKit rejects cross-origin form POSTs, so `ORIGIN` and
  `PUBLIC_SITE_URL` must equal the actual `host:port` you serve on. Mismatched port →
  `403 Cross-site POST form submissions are forbidden` on add-to-cart, login, quiz.
- **Port 3000 is frequently taken** by other projects on this machine — default is
  4173; the script aborts with a clear message if the chosen port is busy.
- **Required secrets have no fallbacks** since the security hardening: `TOKEN_SECRET`
  and explicit `IMGPROXY_KEY`/`IMGPROXY_SALT` must be present. On a fresh clone with no
  `.env`, the script generates one from `.env.example` with `openssl rand -hex 32`
  secrets. The imgproxy key the app signs with must match the running imgproxy
  container's key — using the same `.env` for both (as the script does) keeps them in
  sync; if you rotate keys, restart compose so the container picks them up.
- **`pkill -f "node build/index.js"` is a footgun** — with `-f` it matches its own
  wrapper shell and kills it (exit 144). Use the pidfile (`.run/app.pid`) or
  `dev-stop.sh`, not pkill.

## Driving it (prove it works, don't just launch)

Playwright (chromium) is installed in the pnpm store. Resolve it via
`node_modules/.pnpm/node_modules/playwright/index.js` (CommonJS — `import pw from …;
const { chromium } = pw`). A funnel driver that exercises home → blog → quiz → shop →
cart → chat → admin login and screenshots each step lives in the session scratchpad
history; the key selectors: pillars `[data-testid="pillar-item"]`, admin sidebar
`[data-testid="admin-sidebar"]`, cart badge shows count after add-to-cart.

Login via a driver needs correct wait sequencing — click the submit button
(`/autentific/i`) inside `Promise.all([page.waitForLoadState('networkidle'), click])`,
or it races and looks like a failure while actually succeeding.

Quick non-browser smoke:

```bash
B=http://localhost:4173
for p in / /blog /magazin /quiz/evaluare-somn /asistent /api/health /sitemap.xml; do
  printf '%-24s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' $B$p)"
done
curl -s $B/api/health           # {"status":"ok","checks":{"db":"ok","storage":"ok"}}
```

Seeded content is all SVG, so raster-only behavior (width-descriptor `srcset`) won't
show on seed data — attach a PNG/JPEG cover to a product to exercise it.
