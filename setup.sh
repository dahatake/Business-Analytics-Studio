#!/bin/sh
# Business Analytics Studio — setup (FR-107 / FR-108, macOS / Linux).
# Prepares the template on this PC: checks Node.js, installs the locked dependencies (npm ci) and builds the app.
# Safe by design: no sudo, no global installs, no network access other than the npm registry (npm ci),
# idempotent (skips npm ci when package-lock.json has not changed since the last successful run).
# --workiq (optional, D-14) also checks the Microsoft Work IQ CLI (downloads @microsoft/workiq, may ask you to sign in
# to Microsoft 365, contacts Microsoft; no Work IQ search and no EULA acceptance).
#   sh setup.sh [--skip-build] [--force] [--dry-run] [--workiq]
cd "$(dirname "$0")" || exit 1
SKIP_BUILD=0; FORCE=0; DRY_RUN=0; WORKIQ=0
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --workiq) WORKIQ=1 ;;
    *) echo "Unknown option: $a (use --skip-build, --force, --dry-run, --workiq)" >&2; exit 2 ;;
  esac
done

fail() { echo "Setup failed: $1" >&2; echo "Next action: $2" >&2; exit 1; }
step() { echo "==> $1"; }
run_step() {
  step "$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then echo "    (dry run: skipped)"; return 0; fi
  "$@" || fail "$* (exit code $?)" "Read the messages above, fix the cause and run setup.sh again (it is safe to repeat)."
}

step "Checking Node.js and npm"
command -v node >/dev/null 2>&1 || fail "Node.js was not found." "Install Node.js LTS (22.18 or later) for your user (for example with nvm), then run setup.sh again."
VER="$(node --version | sed 's/^v//')"
MAJOR="${VER%%.*}"; REST="${VER#*.}"; MINOR="${REST%%.*}"
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 18 ]; }; then
  fail "Node.js $VER is older than 22.18." "Install Node.js 22.18 or later and run setup.sh again."
fi
command -v npm >/dev/null 2>&1 || fail "npm was not found." "Reinstall Node.js (npm is included) and run setup.sh again."
echo "    Node.js $VER"
if [ "$(id -u)" = "0" ]; then echo "    Note: root is not needed. Setup only writes inside this folder."; fi

[ -f package-lock.json ] || fail "package-lock.json is missing." "Restore the template folder completely (package-lock.json pins every dependency)."
LOCK_HASH="$(node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('package-lock.json')).digest('hex'))")"
MARKER="node_modules/.bas-setup.json"
UP_TO_DATE=0
if [ "$FORCE" -eq 0 ] && [ -f "$MARKER" ] && grep -q "$LOCK_HASH" "$MARKER"; then UP_TO_DATE=1; fi

if [ "$UP_TO_DATE" -eq 1 ]; then
  step "Dependencies are already installed for this package-lock.json (skipping npm ci; use --force to reinstall)"
else
  # Local install only (no -g). npm ci contacts only the configured npm registry.
  run_step "Installing the locked dependencies (npm ci)" npm ci --no-audit --no-fund
  if [ "$DRY_RUN" -eq 0 ]; then printf '{ "lockHash": "%s", "node": "%s" }\n' "$LOCK_HASH" "$VER" > "$MARKER"; fi
fi

if [ "$SKIP_BUILD" -eq 0 ]; then run_step "Building the app (npm run build -> dist/)" npm run build; fi
run_step "Checking the customer-pack schema (docs/pack.schema.json)" node scripts/bas.ts schema --check
if [ "$WORKIQ" -eq 1 ]; then run_step "Checking the Microsoft Work IQ CLI (optional; no search, no EULA acceptance)" node scripts/bas.ts workiq check; fi

echo ""
echo "Setup finished."
echo "  Start the app (with AI and Work IQ):  npm run preview"
echo "  Start without AI (static server):     sh start.sh"
echo "  Prepare a customer:                   node scripts/bas.ts build \"Customer name\""
echo "  Start a customer:                     sh start.sh \"Customer name\""
if [ "$WORKIQ" -eq 0 ]; then echo "  Work IQ (optional, Microsoft Foundry only): npm run workiq:check   (see users-guide/07-real-data-pack.md)"; fi
