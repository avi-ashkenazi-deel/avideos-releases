#!/bin/bash
#
# uninstall-driver.sh — remove the StreamitAudio HAL driver bundle.
#
# Run as root (the streamit app's DriverInstaller invokes this via
# osascript with administrator privileges; no arguments):
#
#   sudo ./uninstall-driver.sh
#
# Removes the installed bundle and restarts coreaudiod so the "streamit
# Microphone" / "streamit Guest Send" devices disappear. Restarting
# coreaudiod briefly interrupts all system audio.

set -euo pipefail

DEST="/Library/Audio/Plug-Ins/HAL/StreamitAudio.driver"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: must run as root (use sudo or the app's admin prompt)" >&2
    exit 77
fi

if [[ -d "${DEST}" ]]; then
    echo "Removing ${DEST}"
    rm -rf "${DEST}"
else
    echo "No installed driver found at ${DEST} (nothing to remove)"
fi

echo "Restarting coreaudiod"
launchctl kickstart -kp system/com.apple.audio.coreaudiod

echo "Uninstall complete"
