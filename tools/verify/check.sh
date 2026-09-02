#!/bin/sh
# Two checks, because they catch different things and only one of them existed.
#
# 1. `node --check foo.js` parses as a SCRIPT. These are ES modules, and a stray
#    brace that a script parser tolerates takes the whole app down at import
#    time with nothing but "[import failed]" to go on. Checking a .mjs copy
#    parses them as what they actually are.
#
# 2. Parsing says nothing about whether a name exists. Twice now a rename left
#    a reference behind — `fixedPool`, then `path` — and both parsed perfectly
#    and crashed the page. The linter answers that question and nothing else.
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

eslint="tools/verify/node_modules/.bin/eslint"
if [ -x "$eslint" ]; then
  # --quiet: errors only. The warnings are worth reading on their own
  # (tools/verify/check.sh --all prints them) but a check that prints twenty
  # lines every run is a check nobody reads.
  if [ "$1" = "--all" ]; then
    "$eslint" --config tools/verify/eslint.config.mjs "js/**/*.js" "tools/**/*.mjs" || ok=0
  else
    "$eslint" --config tools/verify/eslint.config.mjs --quiet "js/**/*.js" "tools/**/*.mjs" || ok=0
  fi
else
  echo "note: no linter installed — run (cd tools/verify && npm install) to catch undefined names"
fi

[ "$ok" = 1 ] && echo "all modules parse, and every name resolves"
