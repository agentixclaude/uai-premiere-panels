# UAI Smart Export — Premiere Pro panel (macOS)

One-click export of every clip on the timeline to Adobe Media Encoder.

- **Export all** queues each enabled clip on V1 as its own file, cut straight from the sequence, so grade and trim changes are always what exports.
- File name = clip name (`CAM1-3918.mp4`).
- Folder = the client's **Final Output** folder (next to the project folder), or any folder picked with **Browse…**.
- Every file stays under the size limit (2 GB by default); bitrate is worked out from each clip's length.
- H.264, Rec.709, VBR 1-pass, AAC 320 kbps. 8K sequences export at 4K (3840×2160 or 2160×3840).

## Other tabs
- **Grade:** nudge Exposure, Temperature, Tint, Saturation, Contrast, Highlights, Shadows, Whites and Blacks on the selected clips (or every clip in the sequence), and copy one clip's grade to selected clips or to every clip from the same camera. Works on the first Lumetri Color effect of each clip.
- **Review:** jump between REVIEW markers and save a still of each clip's first and last frame to a `QC Stills` folder.
- **Setup:** apply the S-log columns to the Project panel.
- **Check exported files** (Export tab): shows each exported file's real size and flags anything over the limit.

## Install
Open **Terminal**, paste this line, press Return:

```
curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-smart-export/main/install.sh | bash
```

Restart Premiere Pro, then open **Window → Extensions → UAI Smart Export**.

Needs Premiere Pro 2020 or newer and Adobe Media Encoder, on a Mac.

## Updates
The panel checks for a new version each time it opens. When one is out, press **Update now** in the panel and restart Premiere.

## Use
1. Open the client project.
2. Check the export folder at the top of the panel.
3. Press **Export all** (or switch to *Active sequence* / *Selected clips*).
4. Press **Start Queue** in Media Encoder.

Existing files are skipped unless *Replace existing files* is ticked.
