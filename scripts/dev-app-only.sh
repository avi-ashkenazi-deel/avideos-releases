#!/bin/bash
# Generates an Xcode project with the camera extension and audio driver left
# out of the Streamit app target, so the app builds and runs without Developer
# ID certs or a vendored libASPL.
#
#   ./scripts/dev-app-only.sh            # dev build (no extension, no driver)
#   ./scripts/dev-app-only.sh --restore  # full build, for anything you ship
#   ./scripts/dev-app-only.sh --status
#
# **project.yml is never modified.** An earlier version edited it in place,
# which meant every `git pull` failed on a dirty tree and the toggle was one
# careless `git commit -a` away from shipping. Instead the edits are applied to
# a throwaway copy that git ignores, and XcodeGen is pointed at that with
# `--spec`. Both specs produce the same HearIt.xcodeproj, so nothing downstream
# has to know which one was used.
#
# Safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")/.."
SPEC="project.yml"
DEV_SPEC=".xcodegen-dev.yml"
BEGIN="# dev-app-only:begin"
END="# dev-app-only:end"
REAL_ENT="CODE_SIGN_ENTITLEMENTS: Mac/Resources/Streamit.entitlements"
DEV_ENT="CODE_SIGN_ENTITLEMENTS: Mac/Resources/Streamit-dev.entitlements"

generate() {
    if command -v xcodegen >/dev/null 2>&1; then
        xcodegen generate --spec "$1"
    else
        echo "note: xcodegen not on PATH — run 'xcodegen generate --spec $1' yourself."
    fi
}

case "${1:-}" in
--status)
    if [ -f "$DEV_SPEC" ]; then
        echo "app-only: ON  (extension + driver excluded; generated from $DEV_SPEC)"
    else
        echo "app-only: OFF (full build — needs Developer ID and a vendored libASPL)"
    fi
    exit 0
    ;;
--restore)
    rm -f "$DEV_SPEC"
    generate "$SPEC"
    echo "Full build: the camera extension, the audio driver and the shipping"
    echo "entitlements are all back in."
    ;;
"")
    if ! grep -qF "$BEGIN" "$SPEC" || ! grep -qF "$END" "$SPEC"; then
        echo "error: markers missing from $SPEC — was the dependencies block edited by hand?" >&2
        exit 1
    fi
    first=$(grep -nF "$BEGIN" "$SPEC" | head -1 | cut -d: -f1)
    last=$(grep -nF "$END" "$SPEC" | head -1 | cut -d: -f1)
    # Only the lines strictly between the markers.
    body_start=$((first + 1))
    body_end=$((last - 1))

    cp "$SPEC" "$DEV_SPEC"
    sed -i '' "${body_start},${body_end}s/^/#/" "$DEV_SPEC"
    # Entitlements without com.apple.developer.system-extension.install. That
    # one is restricted — only a provisioning profile can grant it — so leaving
    # it in makes even a local test run demand development signing, and it is
    # meaningless here because there is no extension to install.
    sed -i '' "s|$REAL_ENT|$DEV_ENT|" "$DEV_SPEC"
    generate "$DEV_SPEC"

    echo "Excluded the camera extension and audio driver from the app build,"
    echo "and switched to entitlements that sign ad-hoc."
    echo "The virtual camera and virtual microphone will be unavailable."
    ;;
*)
    echo "usage: $0 [--restore|--status]" >&2
    exit 2
    ;;
esac
