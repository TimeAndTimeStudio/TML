#!/usr/bin/env bash
# Owner: Time And Time Studio
# Date: 2026-10-09 10:33 +0700
# License: GPL-3.0-or-later
#
# Runs the TML server and the TML desktop app together.
# Bundle layout only: this script sits next to the `tml` binary (dist/).
#
#   ./run-tml.sh                 start server + app (server first, waits for health)
#
# TML takes no command-line argument of its own -- it refuses any you pass
# and exits, so this script passes none through.
#
# Closing the app window stops the server again — but only the server this
# script started; one that was already running is left alone.
#
# Environment (passed through to the server):
#   TML_PORT, TML_LOG_LEVEL, TML_MSA_CLIENT_ID

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/tml"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

[[ -x "$APP" ]] || die "app binary not found next to this script — run this from dist/"
[[ -n "${WAYLAND_DISPLAY:-}" ]] || die "WAYLAND_DISPLAY is not set; the TML app needs a Wayland session"

PORT="${TML_PORT:-8620}"
BASE="http://127.0.0.1:$PORT"
health() { curl -sf -o /dev/null "$BASE/api/health"; }

# --- server -------------------------------------------------------------------
STARTED_NODE=0
NODE_PID=""
if health; then
  printf 'TML server already running on %s — reusing it.\n' "$BASE"
else
  printf 'Starting the TML server on %s ...\n' "$BASE"
  node "$ROOT/src/index.js" &
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

# --- app + cleanup ------------------------------------------------------------
cleanup() {
  if [[ "$STARTED_NODE" == 1 && -n "$NODE_PID" ]]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
    printf 'TML server stopped.\n'
  fi
}
trap cleanup EXIT INT TERM

"$APP"
# The window closed → falls through → the trap stops the server we started.
