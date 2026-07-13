#!/bin/bash
#
# Install an app icon for both the iPhone and Watch targets.
#
# Usage:
#   ./add-icon.sh path/to/your-image.png
#
# Takes any square-ish image, produces a 1024×1024 PNG, and drops it into the
# iOS and watchOS AppIcon asset catalogs. iOS app icons must be opaque (no
# transparency) and 1024×1024 — this flattens any alpha onto white and resizes.
#
# After running, regenerate the project so Xcode picks up the new catalogs:
#   xcodegen generate
#
set -euo pipefail

SRC="${1:-}"
if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "Usage: ./add-icon.sh path/to/your-image.png"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Flatten onto a white background (removes alpha) and force 1024×1024.
# `sips` ships with macOS.
sips -s format png "$SRC" --out "$TMP/flat.png" >/dev/null
# Composite over white to drop transparency, then size to 1024.
sips --padColor FFFFFF --resampleHeightWidth 1024 1024 "$TMP/flat.png" \
     --out "$TMP/Icon-1024.png" >/dev/null

for dest in \
  "$DIR/iOS/Assets.xcassets/AppIcon.appiconset" \
  "$DIR/Watch/Assets.xcassets/AppIcon.appiconset"; do
  cp "$TMP/Icon-1024.png" "$dest/Icon-1024.png"
  echo "Installed icon → $dest/Icon-1024.png"
done

echo
echo "Done. Now run:  xcodegen generate"
echo "(The Watch icon is circle-masked, so the square corners/gears get cropped.)"
