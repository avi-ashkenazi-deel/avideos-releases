#!/bin/bash
# Build "Design Vault.dmg": the launcher app + an Applications shortcut.
# On a Mac this makes a compressed native DMG with hdiutil; on Linux it makes an
# ISO-format image with genisoimage, which macOS also mounts by double-click.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-dist/Design Vault.dmg}"
STAGE="$(mktemp -d)"
mkdir -p "$(dirname "$OUT")"

cp -R DesignVault.app "$STAGE/Design Vault.app"
chmod +x "$STAGE/Design Vault.app/Contents/MacOS/DesignVault"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read me first.txt" <<'EOF'
1. Drag Design Vault onto Applications.
2. Open Applications and double-click Design Vault.
   If macOS says it can't verify the developer: open System Settings >
   Privacy & Security, scroll down, and click "Open Anyway". Only needed once.
3. First launch downloads your library (about 1 GB) into ~/design-vault.
   Later launches open straight into the vault.
EOF

rm -f "$OUT"
if command -v hdiutil >/dev/null; then
  hdiutil create -volname "Design Vault" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
else
  genisoimage -quiet -V "Design Vault" -D -R -apple -no-pad -o "$OUT" "$STAGE"
fi
rm -rf "$STAGE"
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
