#!/usr/bin/env bash
# One-command local launch of better-base on the HOST (not the phase-runner
# container). Brings up the compose stack, migrates + seeds, builds, and starts
# the adapter-node server, then prints the URL. Idempotent: safe to re-run.
#
# Why this script exists (lessons the hard way):
#   - The committed .env targets the runner container (host.docker.internal),
#     which does NOT resolve on the host. We force localhost here without
#     touching .env.
#   - The adapter-node BUILD does not read .env at runtime, so every var must be
#     exported into the server's process (dotenv only covers pnpm scripts).
#   - SvelteKit's CSRF check rejects form POSTs unless ORIGIN matches the served
#     origin — so ORIGIN/PUBLIC_SITE_URL must equal the actual host:port.
#   - Port 3000 is often taken by other projects; we default to 4173.
#
# Usage:
#   bash scripts/dev-run.sh                 # sleep site on :4173, build + launch
#   SITE_ID=life bash scripts/dev-run.sh    # the life site (9 pillars)
#   PORT=4300 bash scripts/dev-run.sh       # different port
#   SKIP_BUILD=1 bash scripts/dev-run.sh    # reuse the existing build
#   ADMIN_EMAIL=a@b.ro ADMIN_PASSWORD='min12chars…' bash scripts/dev-run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SITE_ID="${SITE_ID:-sleep}"
PORT="${PORT:-4173}"
DB_PORT="${DB_PORT:-5433}"
MINIO_PORT="${MINIO_PORT:-9000}"
IMGPROXY_PORT="${IMGPROXY_PORT:-8888}"
DB_NAME="better_sleep"; [ "$SITE_ID" = "life" ] && DB_NAME="better_life"

say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- .env: create one with dev secrets on a fresh clone, else keep existing ---
if [ ! -f .env ]; then
  say "No .env — generating one from .env.example with fresh dev secrets"
  cp .env.example .env
  gen() { openssl rand -hex 32; }
  # fill the secrets that no longer have fallbacks
  sed -i "s|^IMGPROXY_KEY=.*|IMGPROXY_KEY=$(gen)|" .env
  sed -i "s|^IMGPROXY_SALT=.*|IMGPROXY_SALT=$(gen)|" .env
  sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=$(gen)|" .env
  sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(gen)|" .env
fi

# Pull secrets/creds from .env, then force host-local networking + this port.
set -a; . ./.env; set +a
export SITE_ID PORT
export DATABASE_URL="postgres://better:better@localhost:${DB_PORT}/${DB_NAME}"
export TEST_DATABASE_URL="postgres://better:better@localhost:${DB_PORT}/better_test"
export S3_ENDPOINT="http://localhost:${MINIO_PORT}"
export IMGPROXY_URL="http://localhost:${IMGPROXY_PORT}"
export PUBLIC_SITE_URL="http://localhost:${PORT}"
export ORIGIN="http://localhost:${PORT}"
[ -n "${IMGPROXY_KEY:-}" ] && [ -n "${TOKEN_SECRET:-}" ] || die "IMGPROXY_KEY/TOKEN_SECRET missing from .env"

# --- port check ---
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${PORT} "; then
  die "port ${PORT} is in use — set PORT=<free port> and re-run"
fi

# --- 1. services ---
say "Starting compose services (db, minio, imgproxy)"
docker compose up -d db minio imgproxy
say "Waiting for Postgres to accept connections"
for _ in $(seq 1 30); do
  docker compose exec -T db pg_isready -U better >/dev/null 2>&1 && break; sleep 1
done
docker compose exec -T db pg_isready -U better >/dev/null 2>&1 || die "Postgres did not become ready"

# --- 2. schema + storage + seed ---
say "Applying migrations"; pnpm db:migrate
say "Ensuring media bucket";  pnpm storage:init
say "Seeding demo content for SITE_ID=${SITE_ID}"; pnpm db:seed

# --- 3. optional admin user (idempotent) ---
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  say "Upserting admin ${ADMIN_EMAIL}"
  pnpm user:create -- --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --role admin --name "${ADMIN_NAME:-Admin}" || true
fi

# --- 4. build ---
if [ "${SKIP_BUILD:-}" != "1" ]; then say "Building app"; pnpm build; fi
[ -f apps/web/build/index.js ] || die "no build output — run without SKIP_BUILD=1 first"

# --- 5. launch detached, record pid ---
mkdir -p "$ROOT/.run"
if [ -f "$ROOT/.run/app.pid" ] && kill -0 "$(cat "$ROOT/.run/app.pid")" 2>/dev/null; then
  say "Stopping previous instance ($(cat "$ROOT/.run/app.pid"))"
  kill "$(cat "$ROOT/.run/app.pid")" 2>/dev/null || true; sleep 1
fi
say "Starting server on :${PORT}"
( cd "$ROOT/apps/web" && exec setsid node build/index.js ) >"$ROOT/.run/app.log" 2>&1 < /dev/null &
echo $! > "$ROOT/.run/app.pid"

# --- 6. wait for ready + report ---
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/" 2>/dev/null)" = "200" ] && break; sleep 1
done
code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/" 2>/dev/null || echo 000)"
[ "$code" = "200" ] || { tail -20 "$ROOT/.run/app.log"; die "server did not answer 200 (got $code) — see .run/app.log"; }

health="$(curl -s "http://localhost:${PORT}/api/health" 2>/dev/null || true)"
cat <<EOF

  better-base is up  →  http://localhost:${PORT}   (SITE_ID=${SITE_ID})
  admin:  http://localhost:${PORT}/admin/login
  health: ${health}
  logs:   .run/app.log        stop: bash scripts/dev-stop.sh
EOF
