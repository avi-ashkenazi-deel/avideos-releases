#!/usr/bin/env bash
# Build signed + notarized ChopChop ZIPs for Apple Silicon and Intel, plus latest.json, on a Mac.
#
#   cd videditor/desktop && ./scripts/release-mac.sh
#
# Needs:
#   - macOS with Xcode Command Line Tools, Node 22+, git and cmake (brew install cmake)
#   - a "Developer ID Application" certificate in your login keychain
#     (several? pick one with CSC_NAME="Your Name (TEAMID)")
#   - notarization credentials, either
#       APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#     or a notarytool keychain profile:  APPLE_KEYCHAIN_PROFILE=<name>
# Optional:
#   TAG    release tag the files will live under   (default: videditor-v<version>)
#   BASE   public download folder for latest.json  (default: https://github.com/aviashke/chopchop/releases/download/$TAG)
#   NOTES  release notes shown in the update dialog (default: CHANGELOG.md entry for this version)
#
# Output (in desktop/dist/): ChopChop-<version>-arm64-mac.zip, ChopChop-<version>-x64-mac.zip, latest.json
set -euo pipefail
cd "$(dirname "$0")/.."
DESK="$PWD"; ROOT="$(cd .. && pwd)"
b=$'\033[1m'; g=$'\033[32m'; r=$'\033[31m'; n=$'\033[0m'
step() { printf "\n${b}%s${n}\n" "$*"; }
die() { printf "\n${r}✗ %s${n}\n" "$*" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
APPVER="$(node -p "require('$DESK/package.json').version")"
TAG="${TAG:-videditor-v$VERSION}"
BASE="${BASE:-https://github.com/aviashke/chopchop/releases/download/$TAG}"
FEED="$(node -p "require('$DESK/package.json').videditor.updateFeed")"

step "ChopChop $VERSION → $BASE"
echo "Update feed baked into the app: $FEED"

# ---- checks ------------------------------------------------------------------------------------
[ "$(uname -s)" = Darwin ] || die "Run this on a Mac: signing and notarization need macOS."
[ "$VERSION" = "$APPVER" ] || die "Version mismatch: server $VERSION, app $APPVER (tools/release.mjs keeps them in sync)."
[ -n "$FEED" ] || die "desktop/package.json has no videditor.updateFeed."
xcode-select -p >/dev/null 2>&1 || die "Install the Xcode Command Line Tools: xcode-select --install"
command -v cmake >/dev/null || die "Install cmake: brew install cmake"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node 22 or newer is needed."
IDS="$(security find-identity -v -p codesigning | grep 'Developer ID Application' || true)"
[ -n "$IDS" ] || die "No 'Developer ID Application' certificate in your keychain."
if [ -n "${CSC_NAME:-}" ]; then echo "$IDS" | grep -qF "$CSC_NAME" || die "CSC_NAME '$CSC_NAME' is not one of: $IDS"
elif [ "$(echo "$IDS" | wc -l | tr -d ' ')" != 1 ]; then die "Several Developer ID certificates; choose one with CSC_NAME=...:
$IDS"; fi
if [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] || die "Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or APPLE_KEYCHAIN_PROFILE) for notarization."
fi
printf "${g}✓${n} macOS, tools, certificate and notarization credentials\n"

# ---- dependencies ------------------------------------------------------------------------------
step "Dependencies"
(cd "$ROOT" && npm install --omit=dev --no-audit --no-fund)
npm install --no-audit --no-fund

# ---- whisper (speech to text), both chips ------------------------------------------------------
step "Building whisper for Apple Silicon and Intel"
WORK="${TMPDIR:-/tmp}/chopchop-build"; mkdir -p "$WORK"
[ -d "$WORK/whisper/.git" ] || git clone -q --depth 1 --branch v1.7.6 https://github.com/ggml-org/whisper.cpp.git "$WORK/whisper"
for a in arm64 x86_64; do
  metal=OFF; [ "$a" = arm64 ] && metal=ON
  cmake -S "$WORK/whisper" -B "$WORK/whisper/build-$a" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_OSX_ARCHITECTURES=$a -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 -DGGML_METAL=$metal -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF >/dev/null
  cmake --build "$WORK/whisper/build-$a" -j "$(sysctl -n hw.ncpu)" --target whisper-cli >/dev/null
  lipo -archs "$WORK/whisper/build-$a/bin/whisper-cli"
done

# ---- bundled tools ------------------------------------------------------------------------------
step "Bundling ffmpeg, headless Chrome, whisper and the speech model"
node scripts/fetch-vendor.mjs --arch arm64 --whisper "$WORK/whisper/build-arm64/bin/whisper-cli"
node scripts/fetch-vendor.mjs --arch x64 --whisper "$WORK/whisper/build-x86_64/bin/whisper-cli"

# ---- build, sign, notarize ----------------------------------------------------------------------
step "Building, signing and notarizing (notarization usually takes a few minutes per chip)"
rm -rf dist
npx electron-builder --mac zip --arm64 --x64 -c.mac.notarize=true

# ---- verify like Gatekeeper will ----------------------------------------------------------------
step "Verifying"
for app in dist/mac-arm64/ChopChop.app dist/mac/ChopChop.app; do
  [ -d "$app" ] || die "Missing $app"
  codesign --verify --deep --strict "$app" || die "Signature check failed: $app"
  spctl -a -t exec -vv "$app" 2>&1 | grep -q "Notarized Developer ID" || die "Gatekeeper does not accept $app as notarized"
  xcrun stapler validate "$app" >/dev/null || die "Notarization ticket is not stapled: $app"
  printf "${g}✓${n} %s (%s)\n" "$app" "$(lipo -archs "$app/Contents/MacOS/ChopChop")"
done
for z in "dist/ChopChop-$VERSION-arm64-mac.zip" "dist/ChopChop-$VERSION-x64-mac.zip"; do [ -f "$z" ] || die "Missing $z"; done

# ---- update feed ---------------------------------------------------------------------------------
step "Writing latest.json"
NOTES="${NOTES:-$(awk -v v="$VERSION" '$0 ~ "^## "v" " {f=1; next} /^## / {f=0} f && /^- / {sub(/^- /, "• "); print}' "$ROOT/CHANGELOG.md")}"
node scripts/make-feed.mjs --base "$BASE" --notes "${NOTES:-• ChopChop $VERSION}"

step "Done"
for z in dist/ChopChop-"$VERSION"-*-mac.zip; do printf "  %s  sha256 %s\n" "$z" "$(shasum -a 256 "$z" | cut -d' ' -f1)"; done
echo "  dist/latest.json"
echo
echo "Upload all three to the GitHub release $TAG (assets must keep these exact names)."
