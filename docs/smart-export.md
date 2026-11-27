# UAI Smart Export — guide

[← Back to the panels](../README.md)

<img src="../.github/assets/smart-export.jpg" alt="UAI Smart Export" width="340">

- **Export all** queues each enabled clip on V1 as its own file, cut straight from the sequence, so grade and trim changes are always what exports.
- File name = clip name (`CAM1-3918.mp4`); folder = the client's **Final Output** (or **Browse…**).
- Every file is 4K in its sequence's orientation (3840×2160 or 2160×3840), H.264, Rec.709, AAC 320 kbps, and under the size cap (2 GB default); bitrate = min(200, 15200 ÷ seconds − 0.32) Mbps.
- Source: always the original media, never proxies. Media Encoder renders the original files even while Premiere shows proxies, so 8K footage edited on proxies exports at full quality (checked 25 Nov 2026 with a proxy marked by a red box: the export contained none of it).
- **Verify files** (Results tab) reads every output: exists, H.264, the expected frame size (ffprobe) and under the cap; only files that pass every check show *verified*.

Existing files are skipped unless *Replace existing files* is ticked.

## Both panels
- **Undo / Redo** buttons in the header (Premiere's own history; Cmd+Z / Shift+Cmd+Z also work while the panel has focus).
- **About → New updates**: each version with its date and time and what changed (before → now), from the panel's `changelog.json`. Add an entry there with every release.

## Normal export (1.9.0)
**Export › Project type › Normal export** — for any edit project, not only colour-grading clients.
- **Whole sequence:** one file per ticked sequence, the full timeline, named after the sequence. Nested sequences start unticked.
- **Clips by cuts:** several finished videos edited in one sequence. The longest layer marks each video (background, BGM, or an adjustment layer named `Clip 1`, `Clip 2`…, which always wins when there are 2 or more); every shorter layer inside it belongs to that video. Layers running the whole timeline (logo, watermark) are ignored. Files: `Sequence_Clip01.mp4`, `_Clip02`…
- Settings: H.264 MP4, frame size and frame rate of the sequence (scaled only above 4K), medium bitrate VBR 1-pass (≈10 Mbps for 1080×1920 @30, ≈40 for 4K @30, 6–60 Mbps), AAC 320 kbps. No size cap, no 1-frame edge rule: exact frames.
- Folder: the project's Final Output if there is one, otherwise `Exports` next to the project file (or Change…).
