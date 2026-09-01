#!/bin/sh
# `node --check foo.js` parses as a SCRIPT. These are ES modules, and a stray
# brace that a script parser tolerates takes the whole app down at import time
# with nothing but "[import failed]" to go on. Checking a .mjs copy parses them
# as what they actually are.
set -e
cd "$(dirname "$0")/../.."
tmp="${TMPDIR:-/tmp}/wt-check.$$"
mkdir -p "$tmp"
ok=1
for f in js/*.js tools/*.mjs; do
  cp "$f" "$tmp/$(basename "${f%.js}").mjs" 2>/dev/null || cp "$f" "$tmp/$(basename "$f")"
  node --check "$tmp/$(basename "${f%.js}").mjs" 2>&1 | sed "s|$tmp/[^:]*|$f|" || ok=0
done
rm -rf "$tmp"
[ "$ok" = 1 ] && echo "all modules parse as modules"
