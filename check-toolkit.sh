#!/bin/bash
# UGENTIC Premiere Toolkit — read-only health check (macOS). Paste the output back to Claude.
#   curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-premiere-panels/main/check-toolkit.sh | bash
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
ok(){ printf "PASS  %s\n" "$1"; }; bad(){ printf "FAIL  %s  -> %s\n" "$1" "$2"; }
for p in /opt/homebrew/bin /usr/local/bin; do [ -d $p ] && PATH="$p:$PATH"; done

command -v brew >/dev/null && ok "Homebrew $(brew --version | head -1)" || bad "Homebrew" "install from brew.sh"
for t in ffmpeg yt-dlp; do command -v $t >/dev/null && ok "$t" || bad "$t" "brew install $t"; done
(command -v whisper-cli || command -v whisper-cpp) >/dev/null && ok "whisper-cpp" || bad "whisper-cpp" "brew install whisper-cpp"

for id in com.uai.lumacut com.uai.smartexport com.uai.arenahub; do
  f="$EXT/$id/version.json"
  [ -f "$f" ] && ok "$id v$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f")" || bad "$id" "re-run its install line"
done
[ -d "$HOME/UAI Luma Cut/engine" ] && ok "Luma Cut engine" || bad "Luma Cut engine" "re-run panels install line"
[ -d "$EXT/MCPBridgeCEP" ] && ok "MCP connector panel" || bad "MCP connector panel" "premiere-pro-mcp --install-cep"

for v in 11 12 13 14 15; do printf "CSXS.%s PlayerDebugMode=%s\n" $v "$(defaults read com.adobe.CSXS.$v PlayerDebugMode 2>/dev/null || echo unset)"; done
ls -d /Applications/Adobe\ Premiere\ Pro* /Applications/Adobe\ Media\ Encoder* 2>/dev/null

command -v node >/dev/null && echo "node $(node -v) at $(command -v node)" || bad "node" "brew install node"
command -v premiere-pro-mcp >/dev/null && ok "premiere-pro-mcp $(premiere-pro-mcp --version 2>&1 | tail -1)" || bad "premiere-pro-mcp" "re-run MCP install line"

if [ -f "$CFG" ]; then
  python3 - "$CFG" <<'PY'
import json,sys,os
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("FAIL  claude_desktop_config.json invalid JSON ->",e); sys.exit()
e=d.get("mcpServers",{}).get("premiere-pro")
if not e: print("FAIL  premiere-pro missing in Claude Desktop config -> re-run MCP install line"); sys.exit()
print("Claude Desktop entry:",json.dumps(e))
c=e.get("command","")
if c.endswith("premiere-pro-mcp"): print("FAIL  entry uses the npm shim (Claude Desktop can't find node) -> re-run the fixed MCP install line")
elif not os.path.exists(c): print("FAIL  command not found:",c)
else: print("PASS  Claude Desktop entry")
PY
else bad "Claude Desktop config" "install Claude Desktop, then re-run MCP install line"; fi
LOG="$HOME/Library/Logs/Claude/mcp-server-premiere-pro.log"
[ -f "$LOG" ] && { echo "--- last Claude Desktop log lines:"; tail -8 "$LOG"; }
command -v premiere-pro-mcp >/dev/null && { echo "--- doctor:"; premiere-pro-mcp --doctor 2>&1 | tail -15; }
