#!/usr/bin/env bash
# Owner: Time And Time Studio
# Date: 2026-10-09 10:33 +0700
# License: GPL-3.0-or-later

# Runs the TML server and the TML desktop app together.
#
#   ./run-tml.sh                 start server + app (server first, waits for health)
#   ./run-tml.sh --window-size=1280x800    extra args go to the app
#
# Closing the app window stops the server again — but only the server this
# script started; one that was already running is left alone.
#
# Environment (passed through to the server):
#   TML_PORT, TML_DATA_DIR, TML_LOG_LEVEL, TML_MSA_CLIENT_ID
#   TML_NO_BROWSER — default "1" here: the app window already shows the UI,
#     so the server must not xdg-open the system browser. Set 0 to override.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# App binary: repo layout (tma/build/) or packed bundle (next to this script).
if   [[ -x "$ROOT/tma/build/tml" ]]; then APP="$ROOT/tma/build/tml"
elif [[ -x "$ROOT/tml" ]];           then APP="$ROOT/tml"
else APP=""
fi

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- port: env TML_PORT > config.json > default -----------------------------
USER_PORT="${TML_PORT:-}"
PORT="$USER_PORT"
if [[ -z "$PORT" ]]; then
  DATA_DIR="${TML_DATA_DIR:-$HOME/.tml-launcher}"
  PORT="$(node -e '
    const fs = require("fs");
    try {
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(cfg?.server?.port ?? 8620));
    } catch {
      process.stdout.write("8620");
    }
  ' "$DATA_DIR/config.json" 2>/dev/null || true)"
  PORT="${PORT:-8620}"
fi

BASE="http://127.0.0.1:$PORT"
health() { curl -sf -o /dev/null "$BASE/api/health"; }

# --- server -----------------------------------------------------------------
STARTED_NODE=0
NODE_PID=""
if health; then
  printf 'TML server already running on %s — reusing it.\n' "$BASE"
else
  printf 'Starting the TML server on %s …\n' "$BASE"
  NO_BROWSER="${TML_NO_BROWSER:-1}"
  if [[ -n "$USER_PORT" ]]; then
    TML_PORT="$USER_PORT" TML_NO_BROWSER="$NO_BROWSER" node "$ROOT/src/index.js" &
  else
    TML_NO_BROWSER="$NO_BROWSER" node "$ROOT/src/index.js" &
  fi
  NODE_PID=$!
  STARTED_NODE=1
  for _ in $(seq 1 150); do
    if health; then break; fi
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
      die "the TML server exited early (see its output above)"
    fi
    sleep 0.1
  done
  health || die "the TML server did not answer on $BASE"
fi

# --- app + cleanup ----------------------------------------------------------
cleanup() {
  if [[ "$STARTED_NODE" == 1 && -n "$NODE_PID" ]]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
    printf 'TML server stopped.\n'
  fi
}
trap cleanup EXIT INT TERM

[[ -n "$APP" ]] || die "app binary not found — build (cd tma && ./build.sh) or pack (./pack.sh)"
[[ -n "${WAYLAND_DISPLAY:-}" ]] || die "WAYLAND_DISPLAY is not set; the TML app needs a Wayland session"

"$APP" "$@"
# The window closed → falls through → the trap stops the server we started.
