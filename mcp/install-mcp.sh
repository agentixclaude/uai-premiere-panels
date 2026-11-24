#!/bin/bash
# MCP for Adobe Premiere Pro — team install / update (macOS).
#   curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-premiere-panels/main/mcp/install-mcp.sh | bash
# Installs the open-source premiere-pro-mcp server (MIT, github.com/leancoderkavy/premiere-pro-mcp) at the
# team's tested version, its Premiere connector panel, and the Claude Desktop entry. Safe to run again to update.
set -e
REPO_RAW="https://raw.githubusercontent.com/agentixclaude/uai-premiere-panels/main/mcp"
VERSION="${MCP_VERSION:-$(curl -fsSL "$REPO_RAW/VERSION" 2>/dev/null | tr -d '[:space:]')}"
VERSION="${VERSION:-1.31.0}"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "MCP for Adobe Premiere Pro — installing v$VERSION"

# 1. Homebrew, Node 20.19+ and ffmpeg (ffmpeg is used for trims, slips and frame checks)
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is missing. Install it first: https://brew.sh — then run this again."; exit 1
fi
eval "$(brew shellenv)"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)' && NODE_OK=1
fi
[ "$NODE_OK" = 1 ] || { say "Installing Node.js"; brew install node; }
command -v ffmpeg >/dev/null 2>&1 || { say "Installing ffmpeg"; brew install ffmpeg; }

# 2. The MCP server, pinned to the team version
say "Installing premiere-pro-mcp@$VERSION"
npm install -g "premiere-pro-mcp@$VERSION"
BIN="$(command -v premiere-pro-mcp)"
[ -n "$BIN" ] || { echo "premiere-pro-mcp did not install."; exit 1; }

# 3. The Premiere connector panel (CEP) + debug mode for unsigned panels
say "Installing the Premiere connector"
for v in 9 10 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
"$BIN" --install-cep

# 4. Claude Desktop entry (backs up the config first; keeps every other server)
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
python3 - "$CFG" "$BIN" <<'PY'
import json, os, sys
cfg, binpath = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(cfg) and os.path.getsize(cfg):
    with open(cfg) as f: data = json.load(f)
data.setdefault("mcpServers", {})["premiere-pro"] = {"command": binpath, "args": [], "env": {}}
with open(cfg, "w") as f: json.dump(data, f, indent=2)
print("Claude Desktop: premiere-pro ->", binpath)
PY

# 5. Local check (reads no project)
say "Checking the install"
"$BIN" --doctor || true

say "Done. Restart Premiere Pro and Claude Desktop."
echo "In Premiere: Window > Extensions > MCP for Adobe Premiere Pro (keep it open)."
echo "In Claude: ask \"verify my Premiere connection\" before any edit."
