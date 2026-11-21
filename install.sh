#!/bin/bash
# UAI Smart Export — installer / updater for Adobe Premiere Pro (macOS)
set -e
REPO="agentixclaude/uai-smart-export"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.uai.smartexport"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading UAI Smart Export…"
curl -fsSL "https://codeload.github.com/$REPO/zip/refs/heads/main" -o "$TMP/pkg.zip"
unzip -q "$TMP/pkg.zip" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -type d -name panel | head -1)"
[ -f "$SRC/CSXS/manifest.xml" ] || { echo "Download is incomplete. Try again."; exit 1; }

# remove the panel under its earlier names, if present
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.ugentic.export" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.uai.clipcut"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST"

# Premiere only loads unsigned panels when Adobe's panel developer mode is on.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/version.json")"
echo "Installed UAI Smart Export v$VER"
echo "Restart Premiere Pro, then open Window > Extensions > UAI Smart Export."
