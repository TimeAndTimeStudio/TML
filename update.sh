#!/usr/bin/env bash
# Owner: Time And Time Studio
# Date: 2026-10-10 +0700
# License: GPL-3.0-or-later
#
# Syncs the Node.js app (src/, web/, metadata) into an existing dist bundle
# without touching the packed Chromium app — use after ./pack.sh has run once
# and only the launcher code changed:
#
#   ./update.sh          -> dist/tml-<version>/ refreshed (+ .tar.gz)
#
# The `tml` binary, content_shell.pak and the rest of the Chromium pack stay
# exactly as they are.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is required to read the version"
VER="$(node -p "require('$ROOT/package.json').version")"
DIST="$ROOT/dist"
OUT="$DIST/tml-$VER"

[[ -d "$OUT" ]] || die "dist/tml-$VER does not exist — run ./pack.sh first"

printf 'Updating the Node.js app in %s …\n' "$OUT"

rm -rf "$OUT/src" "$OUT/web"
cp -a "$ROOT/src"        "$OUT/src"
cp -a "$ROOT/web"        "$OUT/web"
cp "$ROOT/package.json"  "$OUT/package.json"
cp "$ROOT/run-tml.sh"    "$OUT/run-tml.sh"
cp "$ROOT/TML.desktop"   "$OUT/TML.desktop"
cp "$ROOT/web/favicon.svg" "$OUT/favicon.svg"

chmod +x "$OUT/run-tml.sh"

# Point the desktop entry at THIS bundle (re-edit after moving the folder).
sed -i "s|^Exec=.*|Exec=$OUT/run-tml.sh|; s|^Icon=.*|Icon=$OUT/favicon.svg|" "$OUT/TML.desktop"

command -v desktop-file-validate >/dev/null && desktop-file-validate "$OUT/TML.desktop"

tar -C "$DIST" -czf "$DIST/tml-$VER.tar.gz" "tml-$VER"

printf '\n  folder    %s  (%s)\n' "$OUT" "$(du -sh --apparent-size "$OUT" | cut -f1)"
printf '  tarball   %s  (%s)\n' "$DIST/tml-$VER.tar.gz" "$(du -sh "$DIST/tml-$VER.tar.gz" | cut -f1)"
printf '  node app synced, tml binary untouched\n'
printf '\ndone\n'
