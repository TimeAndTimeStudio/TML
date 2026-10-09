#!/usr/bin/env bash
# Owner: Time And Time Studio
# Date: 2026-10-09 +0700
# License: GPL-3.0-or-later
#
# TML — one command, no arguments:
#
#   ./build.sh    remove tma/ (always), clone it fresh from GitHub, drop our
#                 tma.conf over the clone's (app_name=tml, app_id=TML — the
#                 one file upstream reads for binary name, resource directory
#                 and Wayland app_id), then run tma's own build + pack and
#                 print every output path.
#
# Identity lives only in ./tma.conf — no other file of tma/ is ever touched.
#
# This script only manages tma/ — nothing else in this repository is touched.
#
# Requires: git, node, curl (a Wayland session to run, not to build).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMA_DIR="$ROOT/tma"
TMA_REPO="https://github.com/TimeAndTimeStudio/TMA.git"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

# --- tma/ exists → drop it ----------------------------------------------------
if [[ -e "$TMA_DIR" ]]; then
  log "Removing the old tma/ — every run starts from a fresh clone"
  rm -rf "$TMA_DIR"
fi

# --- fresh clone --------------------------------------------------------------
log "Cloning TMA from $TMA_REPO"
git clone "$TMA_REPO" "$TMA_DIR"
[[ -d "$TMA_DIR/.git" ]] || die "$TMA_DIR is not a git clone"

# --- identity: our tma.conf replaces the clone's -------------------------------
[[ -f "$ROOT/tma.conf" ]] || die "missing $ROOT/tma.conf"
log "Installing the TML tma.conf (app_name/app_id)"
cp "$ROOT/tma.conf" "$TMA_DIR/tma.conf"

# --- build + pack -------------------------------------------------------------
log "Building (tma/build.sh)"
"$TMA_DIR/build.sh"

log "Packing (pack.sh)"
"$ROOT/pack.sh"

VER="$(node -p "require('$ROOT/package.json').version")"
printf '\n==> build finished\n'
printf '  app (working build)   %s/tma/build/tml\n' "$ROOT"
printf '  portable bundle       %s/dist/tml-%s/\n' "$ROOT" "$VER"
printf '  tarball               %s/dist/tml-%s.tar.gz\n' "$ROOT" "$VER"
printf '  run it now            %s/run-tml.sh\n' "$ROOT"
printf '  on another machine    untar, then ./run-tml.sh\n'
