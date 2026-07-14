#!/usr/bin/env bash
# Stop the local dev app started by dev-run.sh, and optionally the compose stack.
#   bash scripts/dev-stop.sh            # stop the app server only
#   bash scripts/dev-stop.sh --all      # also `docker compose down`
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .run/app.pid ]; then
  pid="$(cat .run/app.pid)"
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "stopped app pid $pid"; fi
  rm -f .run/app.pid
else
  echo "no .run/app.pid — app not tracked (already stopped?)"
fi

if [ "${1:-}" = "--all" ]; then
  echo "stopping compose stack"
  docker compose down
fi
