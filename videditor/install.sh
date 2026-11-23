#!/usr/bin/env bash
# ChopChop installer (Mac). Run:
#   curl -fsSL https://raw.githubusercontent.com/avi-ashkenazi-deel/avideos-releases/Videditor/videditor/install.sh | bash
#
# Installs what is missing (Node 22+, ffmpeg, Google Chrome, Claude Code; needs Homebrew), downloads
# ChopChop into ~/.chopchop and adds the `chopchop` command. `chopchop` gets the latest version each
# time it starts. Your videos, renders and notes live in ~/ChopChop and are never touched by updates.
#
# Options (environment variables):
#   CHOPCHOP_REPO    git URL to install from   (default https://github.com/avi-ashkenazi-deel/avideos-releases.git)
#   CHOPCHOP_BRANCH  branch                     (default Videditor)
#   CHOPCHOP_DIR     where the code goes        (default ~/.chopchop)
#   CHOPCHOP_SKIP_DEPS=1   do not check or install tools
#   CHOPCHOP_NO_START=1    do not start it at the end
set -euo pipefail
REPO="${CHOPCHOP_REPO:-https://github.com/avi-ashkenazi-deel/avideos-releases.git}"
BRANCH="${CHOPCHOP_BRANCH:-Videditor}"
DIR="${CHOPCHOP_DIR:-$HOME/.chopchop}"
OS="$(uname -s)"
b=$'\033[1m'; d=$'\033[2m'; g=$'\033[32m'; y=$'\033[33m'; r=$'\033[31m'; n=$'\033[0m'
step() { printf "\n${b}%s${n}\n" "$*"; }
ok() { printf "  ${g}✓${n} %s\n" "$*"; }
warn() { printf "  ${y}!${n} %s\n" "$*"; }
die() { printf "\n  ${r}✗ %s${n}\n\n" "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
[ "$OS" = "Darwin" ] && export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

printf "${b}ChopChop installer${n}\n${d}code: %s · your videos: ~/ChopChop${n}\n" "$DIR"

step "1/3  Tools"
if [ "${CHOPCHOP_SKIP_DEPS:-}" != "1" ]; then
  if [ "$OS" = "Darwin" ] && ! have brew; then
    die "Homebrew is needed to install the tools. Install it from https://brew.sh (one command), then run this again."
  fi
  brewi() { if [ "$OS" = "Darwin" ]; then brew install "$@" >/dev/null; else die "Please install: $* (then run this again)"; fi; }
  have git || { [ "$OS" = "Darwin" ] && { xcode-select --install 2>/dev/null || true; die "macOS is installing Git (Command Line Tools). Run this again when that finishes."; }; brewi git; }
  ok "git $(git --version | awk '{print $3}')"
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -lt 22 ]; then warn "installing Node.js (need 22 or newer)"; brewi node; hash -r; fi
  ok "node $(node -v)"
  have ffmpeg || { warn "installing ffmpeg"; brewi ffmpeg; }
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
  if [ "$OS" = "Darwin" ]; then
    if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ] || [ -d "/Applications/Microsoft Edge.app" ]; then ok "Chrome found (renders use it)"
    else warn "installing Google Chrome (renders use it)"; brew install --cask google-chrome >/dev/null || warn "could not install Chrome; get it from google.com/chrome"; fi
  fi
  if ! have claude; then warn "installing Claude Code (the agent)"; npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || warn "could not install Claude Code; run: npm install -g @anthropic-ai/claude-code"; fi
  have claude && ok "Claude Code $(claude --version 2>/dev/null | head -1)"
else ok "skipped (CHOPCHOP_SKIP_DEPS=1)"; fi

step "2/3  ChopChop"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only --quiet || die "Could not update $DIR (local changes?). Move it away and run this again."
  ok "updated"
else
  [ -e "$DIR" ] && die "$DIR already exists and is not a ChopChop download. Move it away and run this again."
  # The repository holds other projects too: download only ChopChop's folder (sparse, blobs on demand).
  git clone --quiet --filter=blob:none --sparse --branch "$BRANCH" "$REPO" "$DIR" || die "Could not download from $REPO. Check your internet connection and run this again."
  git -C "$DIR" sparse-checkout set videditor
  ok "downloaded"
fi
# The code is either at the top of the repository or in its videditor/ folder.
if [ -f "$DIR/videditor/server.mjs" ]; then APP="$DIR/videditor"; elif [ -f "$DIR/server.mjs" ]; then APP="$DIR"; else die "$REPO does not contain ChopChop (no server.mjs)."; fi
(cd "$APP" && npm install --omit=dev --no-audit --no-fund >/dev/null) || die "npm install failed in $APP"
chmod +x "$APP/bin/chopchop"
ok "version $(node -p "require('$APP/package.json').version")"

step "3/3  The chopchop command"
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/chopchop" "$HOME/.local/bin/chopchop"
ok "installed: ~/.local/bin/chopchop"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) RC="$HOME/.zshrc"; [ "${SHELL##*/}" = "bash" ] && RC="$HOME/.bash_profile"
     if ! grep -qs '.local/bin' "$RC"; then printf '\n# ChopChop\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"; ok "added ~/.local/bin to your PATH in $RC (open a new Terminal window to use it)"; fi;;
esac

printf "\n${g}${b}ChopChop is installed.${n}\n"
printf "  Start it any time with ${b}chopchop${n} (it gets the latest version first). Stop with ${b}chopchop stop${n}.\n"
have claude && printf "  First time: run ${b}claude${n} once in Terminal to sign in to Claude Code.\n"
if [ "${CHOPCHOP_NO_START:-}" != "1" ]; then echo; "$APP/bin/chopchop" start --no-update; fi
