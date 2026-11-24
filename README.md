# UAI panels for Premiere Pro (macOS)

Two panels for S-Log clone-client footage. They share one look and one installer.

| Panel | Job |
|---|---|
| **UAI Luma Cut** | Sets up a client: reads the raw clips, trims the start/end pause, applies the S-Log grade, builds the timelines. |
| **UAI Smart Export** | Exports every clip as its own 4K H.264 file under 2 GB, named after the clip, into Final Output. |

## Install
Open **Terminal**, paste this line, press Return:

```
curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-premiere-panels/main/install.sh | bash
```

Restart Premiere Pro, then open **Window → Extensions → UAI Luma Cut** and **UAI Smart Export**.
Only one panel: add `-s export` or `-s lumacut` after `bash`.

Needs Premiere Pro 2020 or newer (built and tested on 2027), Adobe Media Encoder, a Mac. Luma Cut's Standalone trim needs ffmpeg (the installer adds it when Homebrew is present).

## Updates
Each panel checks GitHub when it opens. When a new version is out, press **Update now** in the panel and restart Premiere.

---

## UAI Luma Cut

1. **Choose folder…** — the client folder holding `Raw Data` (any folder starting with "Raw") and `Project File`. Folders named like `AC#3 …` are marked **AC client**.
2. **New project for this client** — creates or opens `Project File/<Client>_GRADED.prproj` (e.g. `AC3_ScottFeirn_GRADED`).
3. Pick the mode, then press the big button.

**Standalone** (no Claude): trims from the audio, about 0.8 s before the first word and 0.6 s after the last word, and applies the house grade. Seconds per client.

**Claude**: press **Ask Claude**. The panel writes `luma_request.json` and copies a prompt; paste it into the Claude desktop app on the same Mac. Claude runs the engine (`~/UAI Luma Cut/engine`): IN/OUT on a frame with the mouth closed and the eyes open, and a grade matched per clip (skin brightness and colour, highlights). When `luma_plan.json` appears, the panel shows **Plan ready**; press **Build from Claude's plan**.

Every build makes:
- a `Sequences` bin with one sequence per size and orientation: `<Client>_8K_HZ`, `_8K_VER`, `_4K_HZ`, `_4K_VER`;
- each clip cut head | body | tail, with head and tail left on the timeline, disabled; IN/OUT markers on every body (flagged clips get a red OUT marker);
- one **S-Log Lumetri** per body clip (ALEXA LogC2Rec709 LUT + grade); vertical clips rotated;
- the S-log Project-panel columns, then a save.

Build always makes all sequences together; building again replaces the `Sequences` bin (press twice to confirm).

**Duplicate check** (Build, also runs before every build): decided by content, never by file name. Same size + sampled hash + full SHA-1 = identical copy, skipped. Same shape and length + matching sound at 5 time-aligned points + matching keyframes = same recording in another file, kept and flagged. Everything else is a different take (`CAM2-4309 (1).MP4` included). Results are cached per file (path, size, modified time) in `~/UAI Luma Cut/dupe_cache.json`. The XML it imports is kept as `Project File/<Client>_GRADED.xml`.

**Skin (Custom) pass** — `engine/colormode/cm_clone.py` copies one clip's Color Mode adjustment (Color Shift on skin) to other clips in the saved project and sets each group's Hue / Lum Shift, the same as the Color tab's *Paste Grade → Paste and Replace*. Close the project in Premiere first. Example groups file: one entry per look (office/library, green screen, outdoor) with `from`, `to`, `hue`, `lum`. `cm_tool.py read` lists every clip's values.

**Grade** (all live, Cmd+Z undoes; the panel never saves, closes or reopens the project) — scope Selected / Current sequence / All sequences; Over / Under exposure presets; Overall Lumetri sliders; Remove green (Ultra Key); **Copy / Paste a look**: select a graded clip → Copy, select other clips → Paste (Overall). The default skin + green Color Shift (skin Hue +3.5 Sat +3, green Sat +5) is written once at the end of Build, in the same save and reopen as the build; per-clip skin / green changes are made and copied in Premiere's Color tab (Copy Grade / Paste Grade), because Premiere's scripting can't change Color Shift live.

**Review** — Flagged by system / All clips; a click on a clip selects that exact timeline item. Move a cut with a Rolling Edit, then **Re-sync markers**. **Save grade reference** keeps each listed clip's grade values plus one image (`Final Output/Stills/<clip>_REF.jpg`, 1920 px) and a 320 px copy for learning. **Final check & save learning**: first press compares the timeline with the build baseline (IN/OUT, Lumetri, skin and green Color Shift) and lists the changes; second press keeps them.

**Learning** (`~/UAI Luma Cut/learning`): one batch per client project; only the last 3 batches are kept by default (About: latest only / 3 / 5), capped at 10 MB including images; older batches are erased after a new one is saved. Rules (bounded mean corrections) only switch on after the same correction appears in 2 batches; Standalone applies the Lumetri and trim rules, Claude reads `claude_context.json`. Reset learning (About) keeps a backup file.

Limits: Premiere's scripting cannot set the Lumetri LUT directly, so the grade comes in through the imported XML. Project-panel sorting is a manual click (Video Info header, arrow down).

## UAI Smart Export

- **Export all** queues each enabled clip on V1 as its own file, cut straight from the sequence, so grade and trim changes are always what exports.
- File name = clip name (`CAM1-3918.mp4`); folder = the client's **Final Output** (or **Browse…**).
- Every file is 4K in its sequence's orientation (3840×2160 or 2160×3840), H.264, Rec.709, AAC 320 kbps, and under the size cap (2 GB default); bitrate = min(200, 15200 ÷ seconds − 0.32) Mbps.
- **Verify files** (Results tab) reads every output: exists, H.264, the expected frame size (ffprobe) and under the cap; only files that pass every check show *verified*.

Existing files are skipped unless *Replace existing files* is ticked.

## Both panels
- **Undo / Redo** buttons in the header (Premiere's own history; Cmd+Z / Shift+Cmd+Z also work while the panel has focus).
- **About → New updates**: each version with its date and time and what changed (before → now), from the panel's `changelog.json`. Add an entry there with every release.

## Repo layout
- `panel/` — UAI Smart Export (`com.uai.smartexport`)
- `luma-cut/` — UAI Luma Cut (`com.uai.lumacut`); `lib/` holds the XML builder, MP4 reader and audio trim
- `engine/` — Claude-mode analysis (Python: `luma_plan.py`, `trim.py`, `face.py`, `grade_analyze.py`) and `colormode/` (Color Mode skin tools: `cm_clone.py`, `cm_tool.py`)
- `mcp/` — team installer for the open-source MCP for Adobe Premiere Pro (`install-mcp.sh`, pinned `VERSION`)
- To publish an update: change the files, raise the version in the panel's `version.json` and `CSXS/manifest.xml`, push to `main`.

## MCP for Adobe Premiere Pro (for Claude)

Separate from the panels: lets Claude read and drive Premiere. One line installs the team-tested version:

```bash
curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-premiere-panels/main/mcp/install-mcp.sh | bash
```

Details, rules and troubleshooting: [`mcp/README.md`](mcp/README.md).

## Adding a panel
Each panel is one folder at the top of this repo (`panel/`, `luma-cut/`, …) with its own `CSXS/manifest.xml` (a unique id such as `com.uai.<name>`), its own `version.json` and a copy of `ui.css` with its own theme in `styles.css`. Add an install block for it in `install.sh` and the panel's self-update looks for `<folder>/version.json` on `main`.
Keep the repo small: every update downloads the whole repo as one zip. No footage, LUTs, exports or model weights in here; panels find those on the Mac.
