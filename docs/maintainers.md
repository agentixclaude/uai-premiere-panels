# For maintainers

[← Back to the panels](../README.md)

## Updates
Each panel checks GitHub when it opens. When a new version is out, press **Update now** in the panel and restart Premiere.

## Repo layout
- `panel/` — UAI Smart Export (`com.uai.smartexport`)
- `luma-cut/` — UAI Luma Cut (`com.uai.lumacut`); `lib/` holds the XML builder, MP4 reader and audio trim
- `engine/` — Claude-mode analysis (Python: `luma_plan.py`, `trim.py`, `face.py`, `grade_analyze.py`) and `colormode/` (Color Mode skin tools: `cm_clone.py`, `cm_tool.py`)
- `mcp/` — team installer for the open-source MCP for Adobe Premiere Pro (`install-mcp.sh`, pinned `VERSION`)
- `docs/` — the user guides linked from the README · `.github/` — README images, social preview, issue forms
- To publish an update: change the files, raise the version in the panel's `version.json` and `CSXS/manifest.xml`, push to `main`.

## Adding a panel
Each panel is one folder at the top of this repo (`panel/`, `luma-cut/`, …) with its own `CSXS/manifest.xml` (a unique id such as `com.uai.<name>`), its own `version.json` and a copy of `ui.css` with its own theme in `styles.css`. Add an install block for it in `install.sh` and the panel's self-update looks for `<folder>/version.json` on `main`.
Keep the repo small: every update downloads the whole repo as one zip. No footage, LUTs, exports or model weights in here; panels find those on the Mac.

## Every release, also update
- The version badges at the top of `README.md` (shields.io URLs) and the **What's new** section.
- The panel's `changelog.json` (feeds About › New updates).

## README images
Screenshots in `.github/assets/` are taken from the real panels in headless Chrome with demo project data (no client footage). Retake them after a visible UI change. `social-preview.png` (1280×640) is set in GitHub › Settings › Social preview.
