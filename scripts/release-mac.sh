#!/usr/bin/env bash
# Release build for AVideos Studio: archive, Developer ID sign, notarize.
#
# Prereqs (one time):
#   - Developer ID Application certificate in the login keychain
#   - notarytool credentials: xcrun notarytool store-credentials avideos \
#       --apple-id you@example.com --team-id TEAMID --password app-specific
#
# Usage: scripts/release-mac.sh [TEAM_ID]
set -euo pipefail

TEAM_ID="${1:-${DEVELOPMENT_TEAM:-}}"
if [[ -z "$TEAM_ID" ]]; then
  echo "usage: $0 TEAM_ID (or set DEVELOPMENT_TEAM)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/release"
APP="$BUILD/AVideosStudio.app"
ZIP="$BUILD/AVideosStudio.zip"

echo "==> Generating project"
cd "$ROOT"
xcodegen generate

echo "==> Archiving"
xcodebuild -project HearIt.xcodeproj \
  -scheme AVideosStudio \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Developer ID Application" \
  -archivePath "$BUILD/AVideosStudio.xcarchive" \
  archive

rm -rf "$APP"
cp -R "$BUILD/AVideosStudio.xcarchive/Products/Applications/AVideosStudio.app" "$APP"

echo "==> Verifying nested signatures (extension, driver, helpers)"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Notarizing"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile avideos --wait
xcrun stapler staple "$APP"

echo "==> Done: $APP"
echo "    Distribute the stapled app (zip or dmg). The camera extension and"
echo "    audio driver ride inside and install on first run."
