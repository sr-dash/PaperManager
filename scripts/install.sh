#!/usr/bin/env bash
# Build PaperManager from this checkout and install it, on macOS.
#
#   ./scripts/install.sh             build, install to /Applications, open it
#   ./scripts/install.sh --update    pull the latest commits first
#
# Options: --dest DIR (default /Applications, or ~/Applications when that is not
# writable), --no-launch, --skip-tests. Needs Node.js 22.13 or newer.
#
# An app built on the Mac it runs on carries no quarantine flag, so it opens without the
# Gatekeeper warning that an unsigned download gets. Your library (~/Documents/PaperManager
# or the folder chosen in Settings) is never touched; the previous app goes to the Trash.
set -euo pipefail

cd "$(dirname "$0")/.."

dest=""
update=0
launch=1
tests=1
while [ $# -gt 0 ]; do
  case "$1" in
    --update) update=1 ;;
    --dest) dest="${2:?--dest needs a folder}"; shift ;;
    --no-launch) launch=0 ;;
    --skip-tests) tests=0 ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

log=$(mktemp -t papermanager-build)
trap 'rm -f "$log"' EXIT
# Runs a step quietly; on failure shows the end of its output.
quiet() { "$@" >"$log" 2>&1 || { tail -40 "$log" >&2; fail "'$*' failed (output above)."; }; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this script installs the macOS app. On Linux, see 'Building on Linux' in the README."

# ── Prerequisites ────────────────────────────────────────────────────────────
command -v node >/dev/null && command -v npm >/dev/null ||
  fail "Node.js is not installed. Get the LTS installer from https://nodejs.org, then run this again."
node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); console.log(a>22||(a===22&&b>=13)?1:0)')
[ "$node_ok" = 1 ] || fail "Node.js $(node -v) is too old; PaperManager needs 22.13 or newer (https://nodejs.org)."

case "$(uname -m)" in
  arm64) arch=arm64; out=dist/mac-arm64 ;;
  x86_64) arch=x64; out=dist/mac ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac

if [ -z "$dest" ]; then
  if [ -w /Applications ]; then dest=/Applications; else dest="$HOME/Applications"; fi
fi
mkdir -p "$dest"
target="$dest/PaperManager.app"

# ── Source ───────────────────────────────────────────────────────────────────
if [ "$update" = 1 ]; then
  step "Pulling the latest version"
  [ -d .git ] || fail "--update needs a git checkout (this folder has no .git)."
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    fail "this checkout has local changes; commit or stash them before --update."
  git pull --ff-only
fi
version=$(node -p 'require("./package.json").version')
rev=$( [ -d .git ] && git rev-parse --short HEAD 2>/dev/null || echo "no git")
echo "PaperManager $version ($rev), for $arch, into $dest"

# ── Build ────────────────────────────────────────────────────────────────────
step "Installing dependencies (the first run downloads Electron, about 100 MB)"
quiet npm ci --no-audit --no-fund

if [ "$tests" = 1 ]; then
  step "Running the unit tests"
  quiet npm test
fi

step "Building"
quiet npm run build
rm -rf "$out"
quiet npx electron-builder --mac --dir "--$arch"
[ -d "$out/PaperManager.app" ] || fail "the build did not produce $out/PaperManager.app"
codesign --verify --deep "$out/PaperManager.app"

# ── Install ──────────────────────────────────────────────────────────────────
step "Installing to $target"
binary="$target/Contents/MacOS/PaperManager"
if pgrep -f "$binary" >/dev/null; then
  echo "Quitting the running PaperManager…"
  osascript -e 'quit app "PaperManager"' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -f "$binary" >/dev/null || break; sleep 0.5; done
  pgrep -f "$binary" >/dev/null && fail "PaperManager is still running; quit it and run this again."
fi
if [ -e "$target" ]; then
  trashed="$HOME/.Trash/PaperManager $(date +%Y-%m-%d\ %H.%M.%S).app"
  mv "$target" "$trashed"
  echo "The previous app is in the Trash."
fi
ditto "$out/PaperManager.app" "$target"
codesign --verify --deep "$target"

echo
echo "Installed PaperManager $version at $target"
if [ "$launch" = 1 ]; then open "$target"; fi
