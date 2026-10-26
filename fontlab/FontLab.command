#!/bin/bash
# Double-click this file (macOS) to update FontLab and start it.
# It pulls the latest code, installs anything new, and opens the app in your browser.
# Leave this window open while you use FontLab. Close it (or press Ctrl+C) to stop.
cd "$(dirname "$0")" || exit 1
echo "== FontLab: updating =="
git pull --no-rebase 2>&1 | tail -3
echo "== Installing dependencies (only takes long the first time) =="
npm install --no-audit --no-fund 2>&1 | tail -2
echo "== Starting. Keep this window open. Close it to stop FontLab. =="
npm run dev -- --open --port 5173
