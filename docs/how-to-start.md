# How to start a client — quick guide

[← Back to the panels](../README.md) · [Full Luma Cut guide](luma-cut.md) · [Smart Export guide](smart-export.md)

For UAI Luma Cut 1.9.1+ and UAI Smart Export 1.8.2+. One client at a time: finish it, then open the next.
The same steps are inside the panel: **Luma Cut › About › How to use**.

## Before you start
- Client folder named like `AC#12 Firstname Lastname` (the `AC` marks it as an agency client), holding:
  - `Raw Data` (any folder starting with "Raw") with all the footage
  - `Project File` (empty is fine)
  - `Final Output` (exports and grade stills land here)
- Premiere open, **Window › Extensions › UAI Luma Cut**. If the header shows **Update now**, press it and restart Premiere.

## 1 · Build (Build tab)
1. **Choose folder…** → pick the client folder.
2. **New project for this client** → creates or opens `Project File/<Client>_GRADED.prproj`. You don't import anything by hand.
3. Pick the mode:
   - **Standalone** (default): face-checked IN/OUT + house grade + learned starting values per setup. No Claude needed. Seconds to a few minutes.
   - **Claude**: press **Ask Claude**, paste the copied prompt into the Claude desktop app, wait for **Plan ready**, then **Build from Claude's plan**.
4. **Proxies**: leave **Auto** on (Build › Proxies). After the build, every 4K–8K clip gets a 1080p proxy by itself, for smooth playback. Stills, grade references and exports always use the original files.
5. Press **Analyse and build**. You get `<Client>_8K_HZ / _8K_VER / _4K_HZ / _4K_VER`, IN/OUT markers, head and tail disabled, default skin + green Color Shift. Duplicates are checked by content first.

## 2 · Check the cuts (Review tab → Flagged by system)
6. Click each flagged clip, it is selected on the timeline. IN: mouth closed, eyes open. OUT: before the person stands up or looks aside. Clips marked **REVIEW** used the best frame of the pause, check those first.
7. Move a cut with a Rolling Edit, then **Re-sync markers**.

## 3 · Grade (Grade tab, all live, ⌘Z undoes)
8. Scope **All sequences** → **Check light & colour**. It measures every clip's graded frame and sets Exposure / Highlights / Temp / Tint per setup (office C00xx, green screen CAM, outdoor VG).
9. Eye-check one clip per group. If needed: **Over / Under** preset or the Overall sliders, then **Copy** that clip → select the rest of the group → **Paste**.
10. Skin and green screen: Premiere's **Color tab** (Color Mode "Custom"). Yellow faces → skin Hue toward pink (+2 to +5). Copy Grade / Paste Grade per group.

## 4 · Lock it in (Review tab)
11. **Save grade reference** on your best clips (feeds Check light & colour next time).
12. **Final check & save learning**: first press lists what you changed, second press keeps it. Do this before export.

## 5 · Export (UAI Smart Export)
13. Folder = the client's `Final Output`, **All** → **Export all**. Every clip: 4K, H.264, under 2 GB, named like the clip.
14. **Results › Verify files**: every row should pass.

## If something looks wrong
- Panel not in Window › Extensions → quit Premiere, run the install line again.
- A cut or grade is off after Build → fix it by hand, it is kept as learning at step 11.
- Anything else → [Report a problem](../../../issues/new/choose) with the panel version and a screenshot.
