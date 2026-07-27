#!/bin/bash
# Toggles the camera extension and audio driver out of (and back into) the
# Streamit target's dependencies, then regenerates the Xcode project.
#
# Why this exists: both are embedded build dependencies of the app, so a plain
# `xcodegen generate && xcodebuild` needs real Developer ID certs and a vendored
# libASPL before it will produce a runnable app. For everyday work on the studio,
# the editor, music sections and so on, none of that is relevant — and hand-
# editing project.yml every time is a change you will eventually forget to
# revert before a release build.
#
#   ./scripts/dev-app-only.sh          # comment the block out (dev)
#   ./scripts/dev-app-only.sh --restore  # put it back (release)
#   ./scripts/dev-app-only.sh --status
#
# Safe to run twice; it reports what it did.
set -euo pipefail

cd "$(dirname "$0")/.."
SPEC="project.yml"
BEGIN="# dev-app-only:begin"
END="# dev-app-only:end"
REAL_ENT="CODE_SIGN_ENTITLEMENTS: Mac/Resources/Streamit.entitlements"
DEV_ENT="CODE_SIGN_ENTITLEMENTS: Mac/Resources/Streamit-dev.entitlements"

if ! grep -qF "$BEGIN" "$SPEC" || ! grep -qF "$END" "$SPEC"; then
    echo "error: markers missing from $SPEC — was the dependencies block edited by hand?" >&2
    exit 1
fi

first=$(grep -nF "$BEGIN" "$SPEC" | head -1 | cut -d: -f1)
last=$(grep -nF "$END" "$SPEC" | head -1 | cut -d: -f1)
# Only the lines strictly between the markers.
body_start=$((first + 1))
body_end=$((last - 1))

is_disabled() {
    # Disabled when the first body line is commented.
    sed -n "${body_start}p" "$SPEC" | grep -qE '^\s*#'
}

case "${1:-}" in
--status)
    if is_disabled; then
        echo "app-only: ON  (extension + driver excluded from the app build)"
    else
        echo "app-only: OFF (full build — needs Developer ID and a vendored libASPL)"
    fi
    exit 0
    ;;
--restore)
    if ! is_disabled; then
        echo "Already a full build; nothing to restore."
        exit 0
    fi
    # Strip one leading '#' from each body line, preserving indentation.
    sed -i '' "${body_start},${body_end}s/^\([[:space:]]*\)#/\1/" "$SPEC"
    sed -i '' "s|$DEV_ENT|$REAL_ENT|" "$SPEC"
    echo "Restored the extension and driver, and the shipping entitlements."
    ;;
"")
    if is_disabled; then
        echo "Already app-only; nothing to do."
        exit 0
    fi
    sed -i '' "${body_start},${body_end}s/^/#/" "$SPEC"
    # Swap in entitlements without com.apple.developer.system-extension.install.
    # That one is restricted — only a provisioning profile can grant it — so
    # leaving it in makes even a local test run demand development signing,
    # and it is meaningless here since the extension is excluded.
    sed -i '' "s|$REAL_ENT|$DEV_ENT|" "$SPEC"
    echo "Excluded the camera extension and audio driver from the app build,"
    echo "and switched to entitlements that sign ad-hoc."
    echo "The virtual camera and virtual microphone will be unavailable."
    ;;
*)
    echo "usage: $0 [--restore|--status]" >&2
    exit 2
    ;;
esac

if command -v xcodegen >/dev/null 2>&1; then
    xcodegen generate
else
    echo "note: xcodegen not on PATH — run 'xcodegen generate' yourself."
fi

echo
echo "Reminder: project.yml is now modified. Don't commit it —"
echo "  git checkout project.yml   # or ./scripts/dev-app-only.sh --restore"
