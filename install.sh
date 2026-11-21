#!/bin/bash
# UGENTIC Export — installer / updater for Adobe Premiere Pro (macOS)
set -e
REPO="agentixclaude/ugentic-export"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.ugentic.export"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading UGENTIC Export…"
curl -fsSL "https://codeload.github.com/$REPO/zip/refs/heads/main" -o "$TMP/pkg.zip"
unzip -q "$TMP/pkg.zip" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -type d -name panel | head -1)"
[ -f "$SRC/CSXS/manifest.xml" ] || { echo "Download is incomplete. Try again."; exit 1; }

mkdir -p "$DEST"
cp -R "$SRC/." "$DEST"

# Premiere only loads unsigned panels when Adobe's panel developer mode is on.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/version.json")"
echo "Installed UGENTIC Export v$VER"
echo "Restart Premiere Pro, then open Window > Extensions > UGENTIC Export."
