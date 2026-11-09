#!/bin/sh
# Business Analytics Studio — start (FR-141, macOS: double-click in Finder). Same as start.sh.
cd "$(dirname "$0")" || exit 1
exec sh ./start.sh "$@"
