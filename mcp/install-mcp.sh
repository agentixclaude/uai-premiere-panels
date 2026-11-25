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
# Find brew even when its "Next steps" PATH lines were never run
BREW="$(command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1 || true)"
if [ -z "$BREW" ]; then
  echo "Homebrew is missing. Install it first: https://brew.sh — then run this again."; exit 1
fi
eval "$("$BREW" shellenv)"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)' && NODE_OK=1
fi
[ "$NODE_OK" = 1 ] || { say "Installing Node.js"; brew install node; }
command -v ffmpeg >/dev/null 2>&1 || { say "Installing ffmpeg"; brew install ffmpeg; }

# 2. The MCP server, pinned to the team version
say "Installing premiere-pro-mcp@$VERSION"
# A Node from nodejs.org puts npm's global folder in /usr/local (root-owned) → EACCES.
# In that case use Homebrew's own Node/npm, which installs globals without sudo.
NPM="$(command -v npm)"
# Node was just installed by Homebrew: use its npm, not an older one (nvm etc.) earlier on PATH
[ "$NODE_OK" = 1 ] || NPM="$(brew --prefix)/bin/npm"
if [ ! -w "$("$NPM" prefix -g)/lib" ] && [ ! -w "$("$NPM" prefix -g)" ]; then
  say "npm's global folder is not writable, using Homebrew's Node instead"
  brew list node >/dev/null 2>&1 || brew install node
  NPM="$(brew --prefix)/bin/npm"
fi
"$NPM" install -g "premiere-pro-mcp@$VERSION"
BIN="$("$NPM" prefix -g)/bin/premiere-pro-mcp"
[ -x "$BIN" ] || BIN="$(command -v premiere-pro-mcp || true)"
[ -n "$BIN" ] || { echo "premiere-pro-mcp did not install."; exit 1; }

# 3. The Premiere connector panel (CEP) + debug mode for unsigned panels
say "Installing the Premiere connector"
for v in 9 10 11 12 13 14 15 16; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
"$BIN" --install-cep

# 4. Claude Desktop entry (backs up the config first; keeps every other server)
# Claude Desktop starts servers with a bare PATH (/usr/bin:/bin), so the npm shim's
# "#!/usr/bin/env node" fails there ("Server disconnected"). Point it at node + the script directly.
NODE="$(dirname "$NPM")/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
ENTRY="$("$NPM" root -g)/premiere-pro-mcp/dist/index.js"
[ -f "$ENTRY" ] || { echo "Could not find $ENTRY"; exit 1; }
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
python3 - "$CFG" "$NODE" "$ENTRY" <<'PY'
import json, os, sys
cfg, node, entry = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(cfg) and os.path.getsize(cfg):
    try:
        with open(cfg) as f: data = json.load(f)
    except ValueError as e:
        sys.exit("claude_desktop_config.json is not valid JSON (%s). Fix it or restore a .bak copy, then run this again." % e)
data.setdefault("mcpServers", {})["premiere-pro"] = {"command": node, "args": [entry], "env": {}}
with open(cfg, "w") as f: json.dump(data, f, indent=2)
print("Claude Desktop: premiere-pro ->", node, entry)
PY

# 5. Local check (reads no project)
say "Checking the install"
"$BIN" --doctor || true

say "Done. Restart Premiere Pro and Claude Desktop."
echo "In Premiere: Window > Extensions > MCP for Adobe Premiere Pro (keep it open)."
echo "In Claude: ask \"verify my Premiere connection\" before any edit."
