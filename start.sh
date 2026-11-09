#!/bin/sh
# Business Analytics Studio — start (FR-141, macOS / Linux).
# Starts the built app on 127.0.0.1. With a customer name, starts work/<customer>/ built by `node scripts/bas.ts build`.
# Needs only Node.js (no sudo, no global installs, no network).
#   sh start.sh [customer] [port]
cd "$(dirname "$0")" || exit 1
CUSTOMER="${1:-}"
PORT="${2:-4173}"
MIN_MAJOR=22
MIN_MINOR=18

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js LTS (22.18 or later), then run setup.sh." >&2
  exit 1
fi
VER="$(node --version | sed 's/^v//')"
MAJOR="${VER%%.*}"; REST="${VER#*.}"; MINOR="${REST%%.*}"
if [ "$MAJOR" -lt "$MIN_MAJOR" ] || { [ "$MAJOR" -eq "$MIN_MAJOR" ] && [ "$MINOR" -lt "$MIN_MINOR" ]; }; then
  echo "Node.js $VER is too old. Install Node.js $MIN_MAJOR.$MIN_MINOR or later." >&2
  exit 1
fi

if [ -n "$CUSTOMER" ]; then
  exec node scripts/bas.ts launch "$CUSTOMER" --port "$PORT"
fi
if [ ! -f dist/index.html ]; then
  echo "The app is not built yet. Run setup.sh first." >&2
  exit 1
fi
if ! node scripts/check-build.mjs "$PWD"; then
  echo "The app was not rebuilt after the last change, so it would show an older version. Run npm run build, then start.sh again." >&2
  exit 1
fi
exec node scripts/bas.ts serve --dir dist --port "$PORT"
