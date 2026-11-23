# UAI panels for Premiere Pro (macOS)

Two panels for S-Log clone-client footage. They share one look and one installer.

| Panel | Job |
|---|---|
| **UAI Luma Cut** | Sets up a client: reads the raw clips, trims the start/end pause, applies the S-Log grade, builds the timelines. |
| **UAI Smart Export** | Exports every clip as its own 4K H.264 file under 2 GB, named after the clip, into Final Output. |

## Install
Open **Terminal**, paste this line, press Return:

```
curl -fsSL https://raw.githubusercontent.com/agentixclaude/uai-smart-export/main/install.sh | bash
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

Building again replaces the `Sequences` bin (press twice to confirm). The XML it imports is kept as `Project File/<Client>_GRADED.xml`.

**Grade** — nudge the Best grade on selected clips or the whole sequence; copy one clip's grade to the selection or to every clip from the same camera. The **Custom** look stays a Color Mode adjustment (Color Shift) added by hand: Premiere's scripting cannot create or copy it.

**Review** — every body clip with IN/OUT jump buttons, flagged clips highlighted. Move a cut with a Rolling Edit, then **Re-sync markers**. Saves IN/OUT stills to `QC Stills`.

Limits: Premiere's scripting cannot set the Lumetri LUT directly, so the grade comes in through the imported XML. Project-panel sorting is a manual click (Video Info header, arrow down).

## UAI Smart Export

- **Export all** queues each enabled clip on V1 as its own file, cut straight from the sequence, so grade and trim changes are always what exports.
- File name = clip name (`CAM1-3918.mp4`); folder = the client's **Final Output** (or **Browse…**).
- Every file is 4K in its sequence's orientation (3840×2160 or 2160×3840), H.264, Rec.709, AAC 320 kbps, and under the size cap (2 GB default); bitrate = min(200, 15200 ÷ seconds − 0.32) Mbps.
- **Check exported files** shows each file's real size and flags anything over the cap.
- Also has **Grade**, **Review** and **Setup** tabs (same tools as above).

Existing files are skipped unless *Replace existing files* is ticked.

## Repo layout
- `panel/` — UAI Smart Export (`com.uai.smartexport`)
- `luma-cut/` — UAI Luma Cut (`com.uai.lumacut`); `lib/` holds the XML builder, MP4 reader and audio trim
- `engine/` — Claude-mode analysis (Python: `luma_plan.py`, `trim.py`, `face.py`, `grade_analyze.py`)
- To publish an update: change the files, raise the version in the panel's `version.json` and `CSXS/manifest.xml`, push to `main`.
