#!/usr/bin/env bash
# Owner: Time And Time Studio
# Date: 2026-10-09 +0700
# License: GPL-3.0-or-later
#
# Packs the whole launcher (app + server + desktop files) into one
# self-contained folder you can copy to another machine:
#
#   ./pack.sh                       -> dist/tml-<version>/  (+ .tar.gz)
#
# Bundle layout (flat — the app binary sits next to run-tml.sh):
#   run-tml.sh  tml  content_shell.pak  ...   (no tml_resources: the
#   startup is a URL, so there is no packaged page and no locales)
#   src/  web/  package.json  TML.desktop  favicon.svg
#
# Requirements on the target machine: node, curl, a Wayland session,
# and the usual Chromium runtime libs (GTK3 etc. — same as any Chromium).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$ROOT/tma/build"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -x "$APP_SRC/tml" ]] || die "app not built — run: cd tma && ./build.sh"

command -v node >/dev/null || die "node is required to read the version"

VER="$(node -p "require('$ROOT/package.json').version")"
NAME="tml-$VER"
DIST="$ROOT/dist"
OUT="$DIST/$NAME"

printf 'Packing %s …\n' "$NAME"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- app (Chromium shell, flat) --------------------------------------------
cp -a "$APP_SRC/." "$OUT/"
rm -f "$OUT/content_shell.log"

# --- server + UI + metadata -------------------------------------------------
cp -a "$ROOT/src" "$OUT/src"
cp -a "$ROOT/web" "$OUT/web"
cp "$ROOT/package.json" "$OUT/package.json"
cp "$ROOT/run-tml.sh"   "$OUT/run-tml.sh"
cp "$ROOT/TML.desktop"  "$OUT/TML.desktop"
cp "$ROOT/web/favicon.svg" "$OUT/favicon.svg"

chmod +x "$OUT/run-tml.sh" "$OUT/tml"

# Point the desktop entry at THIS bundle (re-edit after moving the folder).
sed -i "s|^Exec=.*|Exec=$OUT/run-tml.sh|; s|^Icon=.*|Icon=$OUT/favicon.svg|" "$OUT/TML.desktop"

command -v desktop-file-validate >/dev/null && desktop-file-validate "$OUT/TML.desktop"

# --- tarball for moving -----------------------------------------------------
tar -C "$DIST" -czf "$DIST/$NAME.tar.gz" "$NAME"

printf '\n  folder    %s  (%s)\n' "$OUT"   "$(du -sh --apparent-size "$OUT" | cut -f1)"
printf '  tarball   %s  (%s)\n' "$DIST/$NAME.tar.gz" "$(du -sh "$DIST/$NAME.tar.gz" | cut -f1)"
printf '\nOn the other machine:\n'
printf '  1. untar, then run:      ./run-tml.sh\n'
printf '  2. after moving, fix Exec/Icon paths inside TML.desktop, then install:\n'
printf '       cp TML.desktop ~/.local/share/applications/\n'
printf 'done\n'
