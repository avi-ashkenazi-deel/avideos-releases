#!/bin/bash
# Double-click me on a Mac: starts the Design Vault app (if it isn't running) and opens it.
cd "$(dirname "$0")"
if ! lsof -i :5177 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup python3 app/serve.py > /tmp/design-vault.log 2>&1 &
  sleep 1.5
fi
open "http://localhost:5177"
