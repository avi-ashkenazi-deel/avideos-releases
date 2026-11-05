#!/usr/bin/env bash
# Videditor installer. Run:  bash install.sh
# Installs what is missing (Node 22+, ffmpeg, Claude Code; checks Git and Chrome), downloads the newest
# Videditor release, and adds a Videditor app (macOS) plus a `videditor` command. Updates install
# themselves when you open Videditor. Your videos live in ~/Videditor and are never touched by updates.
# Options (env): VIDEDITOR_REPO (git URL), VIDEDITOR_APP (code folder, default ~/.videditor),
#                VIDEDITOR_NO_START=1 (do not open it at the end), VIDEDITOR_SKIP_DEPS=1 (skip tool installs)
set -euo pipefail
REPO="${VIDEDITOR_REPO:-https://github.com/avi-ashkenazi-deel/avideos-releases.git}"
APP="${VIDEDITOR_APP:-$HOME/.videditor}"
OS="$(uname -s)"
b=$'\033[1m'; d=$'\033[2m'; g=$'\033[32m'; y=$'\033[33m'; r=$'\033[31m'; n=$'\033[0m'
step() { printf "\n${b}%s${n}\n" "$*"; }
ok() { printf "  ${g}✓${n} %s\n" "$*"; }
warn() { printf "  ${y}!${n} %s\n" "$*"; }
die() { printf "\n  ${r}✗ %s${n}\n\n" "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
[ "$OS" = "Darwin" ] && export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

printf "${b}Videditor installer${n}\n${d}Code goes to %s · your videos stay in ~/Videditor${n}\n" "$APP"

step "1/4  Tools"
if [ "${VIDEDITOR_SKIP_DEPS:-}" != "1" ]; then
  if [ "$OS" = "Darwin" ] && ! have brew; then
    die "Homebrew is needed to install the tools. Install it from https://brew.sh (one command), then run this again."
  fi
  brewi() { if [ "$OS" = "Darwin" ]; then brew install "$@" >/dev/null; else die "Please install: $* (then run this again)"; fi; }
  have git || { warn "installing git"; [ "$OS" = "Darwin" ] && { xcode-select --install 2>/dev/null || true; die "macOS is installing Git (Command Line Tools). Run this again when that finishes."; }; brewi git; }
  ok "git $(git --version | awk '{print $3}')"
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -lt 22 ]; then warn "installing Node.js (need 22 or newer)"; brewi node; hash -r; fi
  ok "node $(node -v)"
  have ffmpeg || { warn "installing ffmpeg"; brewi ffmpeg; }
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
  if [ "$OS" = "Darwin" ]; then
    if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ] || [ -d "/Applications/Microsoft Edge.app" ]; then ok "Chrome found"
    else warn "installing Google Chrome (renders use it)"; brew install --cask google-chrome >/dev/null || warn "could not install Chrome; install it from google.com/chrome"; fi
  fi
  if ! have claude; then warn "installing Claude Code (the agent)"; npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || warn "could not install Claude Code: run  npm install -g @anthropic-ai/claude-code"; fi
  have claude && ok "Claude Code $(claude --version 2>/dev/null | head -1)"
else ok "skipped (VIDEDITOR_SKIP_DEPS=1)"; fi

step "2/4  Videditor"
mkdir -p "$APP"
if [ -d "$APP/repo/.git" ]; then
  git -C "$APP/repo" fetch --quiet --force --tags origin || die "Could not reach $REPO. Check your GitHub access, then run this again."
  ok "updated the download"
else
  git clone --quiet --filter=blob:none --no-checkout "$REPO" "$APP/repo" || die "Could not download from $REPO. You need read access to that GitHub repository (ask the person who shared Videditor), and Git must be signed in to GitHub (for example: gh auth login)."
  git -C "$APP/repo" sparse-checkout set videditor
  ok "downloaded"
fi
TAG=$(git -C "$APP/repo" tag -l 'videditor-v*' --sort=-v:refname | head -1)
[ -n "$TAG" ] || die "No Videditor release found in $REPO yet (tags named videditor-v1.2.3)."
git -C "$APP/repo" checkout --quiet --force "$TAG"
ok "version ${TAG#videditor-v}"
cd "$APP/repo/videditor"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed in $APP/repo/videditor"
ok "dependencies installed"
cat > .install.json <<JSON
{ "repo": "$REPO", "app": "$APP", "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON

step "3/4  Launcher"
NODE_BIN="$(command -v node)"
LAUNCH="$APP/repo/videditor/launcher.mjs"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/videditor" <<SH
#!/bin/sh
exec "$NODE_BIN" "$LAUNCH" "\$@"
SH
chmod +x "$HOME/.local/bin/videditor"
ok "command: videditor   ${d}(in ~/.local/bin)${n}"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "add ~/.local/bin to your PATH to use the command from any terminal";; esac
if [ "$OS" = "Darwin" ]; then
  APPDIR="$HOME/Applications/Videditor.app"
  mkdir -p "$APPDIR/Contents/MacOS" "$APPDIR/Contents/Resources"
  cat > "$APPDIR/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Videditor</string>
  <key>CFBundleIdentifier</key><string>local.videditor.launcher</string>
  <key>CFBundleExecutable</key><string>Videditor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
  cat > "$APPDIR/Contents/MacOS/Videditor" <<SH
#!/bin/sh
exec "$NODE_BIN" "$LAUNCH" >> "\$HOME/Videditor/logs/launcher.log" 2>&1
SH
  chmod +x "$APPDIR/Contents/MacOS/Videditor"
  mkdir -p "$HOME/Videditor/logs"
  ok "app: ~/Applications/Videditor  ${d}(open it from Spotlight or drag it to the Dock)${n}"
fi

step "4/4  Start"
if [ "${VIDEDITOR_NO_START:-}" = "1" ]; then ok "skipped (VIDEDITOR_NO_START=1)"; else "$NODE_BIN" "$LAUNCH" || true; fi
printf "\n${g}${b}Videditor is installed.${n}\n"
have claude && printf "  If the agent asks you to sign in: run ${b}claude${n} once in Terminal.\n"
printf "  Updates install themselves when you open Videditor.\n\n"
