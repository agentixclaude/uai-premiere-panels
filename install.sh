#!/bin/bash
# UAI panels for Adobe Premiere Pro (macOS) — installs or updates:
#   UAI Smart Export  (Window > Extensions > UAI Smart Export)
#   UAI Luma Cut      (Window > Extensions > UAI Luma Cut) + its Claude-mode engine in ~/UAI Luma Cut/engine
# Usage: install.sh            both panels
#        install.sh export     UAI Smart Export only
#        install.sh lumacut    UAI Luma Cut only
set -e
REPO="agentixclaude/uai-smart-export"
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
WHAT="${1:-all}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading UAI panels…"
curl -fsSL "https://codeload.github.com/$REPO/zip/refs/heads/main" -o "$TMP/pkg.zip"
unzip -q "$TMP/pkg.zip" -d "$TMP"
ROOT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -f "$ROOT/panel/CSXS/manifest.xml" ] || { echo "Download is incomplete. Try again."; exit 1; }
mkdir -p "$EXT"

version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/version.json"; }

if [ "$WHAT" = "all" ] || [ "$WHAT" = "export" ]; then
  # remove the panel under its earlier names, if present
  rm -rf "$EXT/com.ugentic.export" "$EXT/com.uai.clipcut"
  mkdir -p "$EXT/com.uai.smartexport"
  cp -R "$ROOT/panel/." "$EXT/com.uai.smartexport"
  echo "Installed UAI Smart Export v$(version "$EXT/com.uai.smartexport")"
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "lumacut" ]; then
  mkdir -p "$EXT/com.uai.lumacut"
  cp -R "$ROOT/luma-cut/." "$EXT/com.uai.lumacut"
  mkdir -p "$HOME/UAI Luma Cut/engine"
  cp -R "$ROOT/engine/." "$HOME/UAI Luma Cut/engine"
  echo "Installed UAI Luma Cut v$(version "$EXT/com.uai.lumacut") (engine in ~/UAI Luma Cut/engine)"
  if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/ffmpeg ] && [ ! -x /usr/local/bin/ffmpeg ]; then
    if command -v brew >/dev/null 2>&1; then
      echo "Installing ffmpeg (Standalone trim reads the audio with it)…"
      brew install ffmpeg || echo "ffmpeg install failed. Standalone trim will keep full clips until ffmpeg is installed."
    else
      echo "Note: ffmpeg is not installed. Standalone trim needs it: install Homebrew (brew.sh), then run: brew install ffmpeg"
    fi
  fi
fi

# Premiere only loads unsigned panels when Adobe's panel developer mode is on.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo "Restart Premiere Pro, then open the panels from Window > Extensions."
