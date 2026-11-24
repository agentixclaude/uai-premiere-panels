# MCP for Adobe Premiere Pro — team setup

Lets Claude (Desktop, or Claude Code on the edit Mac) read and drive Premiere Pro: timelines, clips, effects, markers, exports.
It is the open-source **premiere-pro-mcp** server (MIT, [github.com/leancoderkavy/premiere-pro-mcp](https://github.com/leancoderkavy/premiere-pro-mcp)) plus its Premiere connector panel.
This folder only pins the version the team has tested and installs it the same way on every Mac. No code is copied here.

| | |
|---|---|
| Tested version | see [`VERSION`](VERSION) (currently **1.31.0**, Premiere Pro 2027 / 27.0, macOS) |
| Needs | macOS, Homebrew, Premiere Pro, Claude Desktop. Node 20.19+ and ffmpeg are installed for you. |
| Installs | `premiere-pro-mcp` (global npm), connector panel **MCP for Adobe Premiere Pro** (CEP), the `premiere-pro` entry in Claude Desktop's config |

## Install or update (one line)

Quit Premiere Pro first, then in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-premiere-panels/main/mcp/install-mcp.sh | bash
```

Then:
1. Open Premiere Pro and a project → **Window › Extensions › MCP for Adobe Premiere Pro**. Keep the panel open (it can sit behind other panels).
2. Restart Claude Desktop.
3. First prompt: **"verify my Premiere connection"**. It is read-only and tells you if anything is missing.

Running the same line again updates everyone to the version in `VERSION`. The installer backs up `claude_desktop_config.json` before touching it and keeps every other MCP server.

## Rules for the team

- **Test on a copy.** Try new prompts on a scratch project or a duplicated sequence, never straight on a client's master.
- **One project open** when you ask Claude to edit, or name the project in the prompt. The server refuses to run if the open project differs from the one it was told to use.
- **Save before big changes**; ⌘Z undoes most single steps.
- Our own panels (UAI Luma Cut, UAI Smart Export, Agentix Arena Hub) do not need the MCP. It is a tool for Claude, not for the panels.

## Troubleshooting

```bash
premiere-pro-mcp --doctor          # checks the install without opening a project
premiere-pro-mcp --diagnose-cep    # checks the connector panel and debug keys
premiere-pro-mcp --version
```

- Panel missing in Window › Extensions → quit Premiere, run the install line again.
- Claude shows no Premiere tools → Claude Desktop › Settings › Developer: `premiere-pro` should be running; restart Claude Desktop.
- "Premiere did not answer" → the connector panel is closed, or no project is open.

## For whoever maintains this

To move the team to a newer release: check the [changelog](https://github.com/leancoderkavy/premiere-pro-mcp/blob/main/CHANGELOG.md), install it on one Mac (`MCP_VERSION=x.y.z bash install-mcp.sh`), run a read-only check plus one edit on a scratch project, then change `VERSION` and push. Everyone picks it up next time they run the install line.

Uninstall: `premiere-pro-mcp --uninstall-cep && npm uninstall -g premiere-pro-mcp`, then remove `premiere-pro` from `~/Library/Application Support/Claude/claude_desktop_config.json`.
