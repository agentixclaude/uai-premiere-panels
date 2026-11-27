# UAI Smart Export — guide

[← Back to the panels](../README.md)

<img src="../.github/assets/smart-export.jpg" alt="UAI Smart Export" width="340">

- **Export all** queues each enabled clip on V1 as its own file, cut straight from the sequence, so grade and trim changes are always what exports.
- File name = clip name (`CAM1-3918.mp4`); folder = the client's **Final Output** (or **Browse…**).
- Every file is 4K in its sequence's orientation (3840×2160 or 2160×3840), H.264, Rec.709, AAC 320 kbps, and under the size cap (2 GB default); bitrate = min(200, 15200 ÷ seconds − 0.32) Mbps.
- Source: always the original media, never proxies. Media Encoder renders the original files even while Premiere shows proxies, so 8K footage edited on proxies exports at full quality (checked 25 Nov 2026 with a proxy marked by a red box: the export contained none of it).
- **Verify files** (Results tab) reads every output: exists, H.264, the expected frame size (ffprobe) and under the cap; only files that pass every check show *verified*.

Existing files are skipped unless *Replace existing files* is ticked.

## 1.10.0 — layout, QC, delivery
**Layout.** Tabs Export · QC · Deliver · About. Project type and What to export are two dropdowns. Outputs are chips (Master always, Social, Review pack). One **Output line** (`H.264 · rule · Auto QC · next file name`) opens **Export settings** (also the sliders button in the header), one section open at a time: Size + bitrate, Naming + versions, Auto QC, Review pack, Delivery set, Preview gamma guard.

**Size rules (colour grading).** Auto: a folder named like `AC#9 …` = AC rule (every file under the cap, 2 GB default); any other folder = Client rule: 8K source → 4K, target 4.65 GB (4.5–4.8 GB band), max 200 Mbps; 4K source stays 4K, max 90 Mbps, under 2 GB. A clip shorter than about 3 min cannot reach 4.5 GB at 200 Mbps; it stays at 200 Mbps and QC notes it is under the band (not a fail). Settings › Size + bitrate can force AC or Client.

**Naming + versions.** One template per project type. Tokens `{Project}` `{Sequence}` (spaces → CamelCase), `{Clip}` (clip name / `Clip01` / marker name), `{Ratio}` (9x16, 16x9, 4x5…), `{Date}`, `v{NN}` (next free version in the folder). Defaults: colour grading `{Clip}`; Normal `{Project}_{Sequence}_{Clip}_{Ratio}_v{NN}`. *Never overwrite* gives a taken name `_v02`, `_v03`.

**Export by markers (Normal).** Sequence markers named `Clip …` start a video that runs to the next `Clip …` or `End` marker, or to the end of the sequence; a `Clip …` marker with a duration is its own range.

**Auto QC.** Every queued file is watched while the panel is open; when its size stops changing and it reads as a finished MP4, it is checked with ffmpeg:
- Start / end: black frames = fail; a still picture for most of the first/last second = flagged (amber, not a fail — end cards are often still on purpose).
- Loudness: −14 ±1 LUFS on Normal export; shown as info on colour grading (masters keep the source level).
- Duration = timeline (±2 frames; colour grading expects the 1-frame clean edge on both sides).
- Codec · frame size · frame rate · size band.
Four dots per file, details on click, **Go to problem** (opens the sequence at the spot), Play, Show in Finder, Re-check, Frames (contact sheet), Remove. A Mac notification when all are done. **Check all** checks files exported earlier too.

**Social + Review pack.** Made from the master after it passes: `Social/<name>_Social.mp4` (1080 wide, 8 Mbps, fast start, loudness to the target) and `Review/<name>_review720.mp4` (under 16 MB), `_sheet.jpg` (first/middle/last), `_cover.png` (sequence marker named `cover`, else frame 1).

**Preview gamma guard.** Reads `ColorManagementSettings.sdrGamma` from the saved project (no key = 2.4). Not 1.96 → banner. **Set 1.96** (press twice) saves, closes, sets the value in every colour block, reopens; a backup is kept in `~/Library/Application Support/UAI Smart Export/backups`. Tested 27 Nov 2026: Project Settings › Color then shows Viewer Gamma 1.96 (QuickTime).

**Deliver.** Only QC-passed files. 1) Copy to a Google Drive for desktop folder (account picked from the Drive folders on the Mac, default `My Drive/UAI Deliveries/<Project>`) with a `QC_Report_*.md`. 2) Asana and 3) Slack: the panel copies a hand-off prompt and opens the Claude app; Claude moves the Creative Requests task to QC 1 and drafts the Slack note, and asks before changing anything. Hand off shows a summary first; press again to confirm.

## Both panels
- **Undo / Redo** buttons in the header (Premiere's own history; Cmd+Z / Shift+Cmd+Z also work while the panel has focus).
- **About → New updates**: each version with its date and time and what changed (before → now), from the panel's `changelog.json`. Add an entry there with every release.

## Normal export (1.9.0)
**Export › Project type › Normal export** — for any edit project, not only colour-grading clients.
- **Whole sequence:** one file per ticked sequence, the full timeline, named after the sequence. Nested sequences start unticked.
- **Clips by cuts:** several finished videos edited in one sequence. The longest layer marks each video (background, BGM, or an adjustment layer named `Clip 1`, `Clip 2`…, which always wins when there are 2 or more); every shorter layer inside it belongs to that video. Layers running the whole timeline (logo, watermark) are ignored. Files: `Sequence_Clip01.mp4`, `_Clip02`…
- Settings: H.264 MP4, frame size and frame rate of the sequence (scaled only above 4K), medium bitrate VBR 1-pass (≈10 Mbps for 1080×1920 @30, ≈40 for 4K @30, 6–60 Mbps), AAC 320 kbps. No size cap, no 1-frame edge rule: exact frames.
- Folder: the project's Final Output if there is one, otherwise `Exports` next to the project file (or Change…).
