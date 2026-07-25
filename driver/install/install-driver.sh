#!/bin/bash
#
# install-driver.sh — install the AVideosAudio HAL driver bundle.
#
# Run as root. The AVideos Studio app's DriverInstaller invokes this via
# osascript "do shell script ... with administrator privileges", passing the
# bundled driver as $1:
#
#   sudo ./install-driver.sh /path/to/AVideosAudio.driver
#
# Steps: replace any existing install, fix ownership/permissions (coreaudiod
# refuses plug-ins not owned by root:wheel), then restart coreaudiod so the
# new devices appear. Restarting coreaudiod briefly interrupts all system
# audio.

set -euo pipefail

HAL_DIR="/Library/Audio/Plug-Ins/HAL"
DEST="${HAL_DIR}/AVideosAudio.driver"

if [[ $# -ne 1 ]]; then
    echo "usage: $0 /path/to/AVideosAudio.driver" >&2
    exit 64
fi

SRC="$1"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: must run as root (use sudo or the app's admin prompt)" >&2
    exit 77
fi

if [[ ! -d "${SRC}" ]]; then
    echo "error: source driver bundle not found: ${SRC}" >&2
    exit 66
fi

if [[ ! -f "${SRC}/Contents/Info.plist" ]]; then
    echo "error: ${SRC} does not look like a .driver bundle (no Contents/Info.plist)" >&2
    exit 65
fi

echo "Installing driver: ${SRC} -> ${DEST}"

mkdir -p "${HAL_DIR}"

if [[ -d "${DEST}" ]]; then
    echo "Removing existing install at ${DEST}"
    rm -rf "${DEST}"
fi

echo "Copying bundle"
cp -R "${SRC}" "${DEST}"

echo "Setting ownership (root:wheel) and permissions (755)"
chown -R root:wheel "${DEST}"
chmod -R 755 "${DEST}"

echo "Restarting coreaudiod"
launchctl kickstart -kp system/com.apple.audio.coreaudiod

echo "Install complete: ${DEST}"
