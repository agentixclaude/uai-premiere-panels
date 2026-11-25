// UAI Luma Cut — Premiere host script (ExtendScript, ES3). Every function is prefixed lc so it never
// collides with UAI Smart Export (Premiere runs all panels' host scripts in one engine).
function lcEsc(s) {
    s = String(s);
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ');
}
function lcErr(e) { return '{"error":"' + lcEsc(e.toString()) + '"}'; }

// ---------------- Project ----------------
function lcInfo() {
    try {
        var p = app.project, appPath = '';
        try { appPath = app.path; } catch (e0) {}
        if (!p || !p.path) { return '{"open":false,"appPath":"' + lcEsc(appPath) + '"}'; }
        var act = p.activeSequence, seqs = '';
        for (var i = 0; i < p.sequences.numSequences; i++) { seqs += (i ? ',' : '') + '"' + lcEsc(p.sequences[i].name) + '"'; }
        return '{"open":true,"appPath":"' + lcEsc(appPath) + '","projectPath":"' + lcEsc(p.path) + '","projectName":"' + lcEsc(p.name) +
            '","active":"' + (act ? lcEsc(act.name) : '') + '","sequences":[' + seqs + '],"hasSequencesBin":' + (lcRootBin('Sequences') ? 'true' : 'false') + '}';
    } catch (e) { return lcErr(e); }
}
function lcRootBin(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var it = root.children[i];
        if (it.type === ProjectItemType.BIN && it.name === name) { return it; }
    }
    return null;
}
// Creates the project file (or opens it when it already exists)
function lcNewProject(path) {
    try {
        var f = new File(path);
        if (f.exists) { app.openDocument(path, true, true, true); return 'OK:opened'; }
        app.newProject(path);
        return 'OK:created';
    } catch (e) { return 'ERR:' + e.toString(); }
}
function lcSave() {
    try { app.project.save(); return 'OK'; } catch (e) { return 'ERR:' + e.toString(); }
}
// Rebuild: the Sequences bin holds the sequences and their clips, so removing it clears the old build
function lcClearBuild() {
    try {
        var b = lcRootBin('Sequences');
        if (!b) { return 'OK:none'; }
        b.deleteBin();
        return lcRootBin('Sequences') ? 'ERR:the old Sequences bin could not be removed' : 'OK:removed';
    } catch (e) { return 'ERR:' + e.toString(); }
}
// Import the built XML into the open project; lift its "Sequences" bin to the top level
function lcImportXml(xmlPath) {
    try {
        var p = app.project, before = p.sequences.numSequences, stem = String(new File(xmlPath).name).replace(/\.xml$/i, '');
        var ok = p.importFiles([xmlPath], true, p.rootItem, false);
        var after = p.sequences.numSequences;
        if (after <= before) { return 'ERR:Premiere imported no sequences from the XML'; }
        // Premiere may wrap the import in a bin named after the file: move its children up and drop it
        var root = p.rootItem;
        for (var i = root.children.numItems - 1; i >= 0; i--) {
            var it = root.children[i];
            if (it.type !== ProjectItemType.BIN || (it.name !== stem && it.name !== stem + '.xml')) { continue; }
            for (var k = it.children.numItems - 1; k >= 0; k--) { it.children[k].moveBin(root); }
            if (it.children.numItems === 0) { it.deleteBin(); }
        }
        var names = '';
        for (var s = before; s < after; s++) { names += (s > before ? ',' : '') + '"' + lcEsc(p.sequences[s].name) + '"'; }
        return '{"added":' + (after - before) + ',"sequences":[' + names + ']}';
    } catch (e) { return lcErr(e); }
}
function lcColumns(xml) {
    try { app.project.setProjectPanelMetadata(xml); return 'OK'; } catch (e) { return 'ERR:' + e.toString(); }
}
function lcPickFolder(startPath, prompt) {
    try {
        var start = startPath ? new Folder(startPath) : null;
        var f = start && start.exists ? start.selectDlg(prompt) : Folder.selectDialog(prompt);
        return f ? f.fsName : '';
    } catch (e) { return ''; }
}

// ---------------- Grade (first Lumetri Color on the clip = the "Best" grade) ----------------
var LC_KEYS = ['temperature', 'tint', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
var LC_NAMES = ['Temperature', 'Tint', 'Saturation', 'Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks'];
function lcLumetri(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
        if (clip.components[i].matchName === 'AE.ADBE Lumetri') { return clip.components[i]; }
    }
    return null;
}
function lcBasic(comp) {
    var map = {}, inBasic = false, n = comp.properties.numItems;
    for (var i = 0; i < n; i++) {
        var d = comp.properties[i].displayName;
        if (d === 'Basic Correction') { inBasic = true; continue; }
        if (d === 'Creative') { break; }
        if (!inBasic) { continue; }
        for (var k = 0; k < LC_NAMES.length; k++) {
            if (d === LC_NAMES[k] && map[LC_KEYS[k]] === undefined) { map[LC_KEYS[k]] = comp.properties[i]; }
        }
    }
    return map;
}
function lcCamera(name) {
    var stem = String(name).replace(/\.[^.]+$/, '');
    var m = stem.match(/^([A-Za-z]+\d*)[-_ ]/);
    if (m) { return m[1].toUpperCase(); }
    m = stem.match(/^([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : stem.toUpperCase();
}
function lcTargets(scope, cam) {
    var s = app.project.activeSequence, out = [], i;
    if (!s) { return out; }
    if (scope === 'selected') {
        var sel = s.getSelection();
        for (i = 0; sel && i < sel.length; i++) {
            if (sel[i].mediaType === 'Video' && !sel[i].disabled) { out.push(sel[i]); }
        }
    } else if (s.videoTracks.numTracks > 0) {
        var t = s.videoTracks[0];
        for (i = 0; i < t.clips.numItems; i++) {
            var c = t.clips[i];
            if (c.disabled) { continue; }
            if (scope === 'camera' && lcCamera(c.name) !== cam) { continue; }
            out.push(c);
        }
    }
    return out;
}
function lcRound(v) { return Math.round(v * 100) / 100; }
function lcValuesJson(clip) {
    var l = lcLumetri(clip);
    if (!l) { return null; }
    var b = lcBasic(l), out = '{';
    for (var k = 0; k < LC_KEYS.length; k++) {
        var p = b[LC_KEYS[k]];
        out += (k ? ',' : '') + '"' + LC_KEYS[k] + '":' + (p ? lcRound(p.getValue()) : 'null');
    }
    return out + '}';
}
// Lumetri (Best grade) values of every graded body clip in every sequence: { "<clip>": {...} }
function lcAllGrades() {
    try {
        var p = app.project, out = '{', first = true, seen = {};
        for (var i = 0; i < p.sequences.numSequences; i++) {
            var s = p.sequences[i];
            if (s.videoTracks.numTracks < 1) { continue; }
            var t = s.videoTracks[0];
            for (var c = 0; c < t.clips.numItems; c++) {
                var k = t.clips[c];
                if (k.disabled || seen[k.name]) { continue; }
                var v = lcValuesJson(k);
                if (!v) { continue; }
                seen[k.name] = true;
                out += (first ? '' : ',') + '"' + lcEsc(k.name) + '":' + v; first = false;
            }
        }
        return out + '}';
    } catch (e) { return lcErr(e); }
}
// Grade targets: 'selected' (selection in the open sequence) / 'sequence' (open sequence) / 'all' (every sequence).
// Returns [{ seq, index, clip }] for enabled clips on V1.
function lcScope(scope) {
    var p = app.project, act = p.activeSequence, out = [], i, j;
    var take = function (s, onlySel) {
        if (!s || s.videoTracks.numTracks < 1) { return; }
        var t = s.videoTracks[0];
        for (j = 0; j < t.clips.numItems; j++) {
            var c = t.clips[j];
            if (c.disabled) { continue; }
            if (onlySel) { var sel = false; try { sel = c.isSelected(); } catch (e1) {} if (!sel) { continue; } }
            out.push({ seq: s, index: j, clip: c });
        }
    };
    if (scope === 'all') { for (i = 0; i < p.sequences.numSequences; i++) { take(p.sequences[i], false); } }
    else { take(act, scope === 'selected'); }
    return out;
}
function lcTargetNames(scope) {
    try {
        var s = app.project.activeSequence;
        if (!s && scope !== 'all') { return '{"error":"Open one of the client sequences first."}'; }
        var t = lcScope(scope), names = [], seen = {}, seqs = {}, nseq = 0;
        for (var i = 0; i < t.length; i++) {
            if (!seqs[t[i].seq.sequenceID]) { seqs[t[i].seq.sequenceID] = 1; nseq++; }
            if (seen[t[i].clip.name]) { continue; }
            seen[t[i].clip.name] = true; names.push('"' + lcEsc(t[i].clip.name) + '"');
        }
        return '{"sequence":"' + (s ? lcEsc(s.name) : '') + '","sequenceId":"' + (s ? lcEsc(s.sequenceID) : '') + '","position":"' + (s ? s.getPlayerPosition().ticks : '0') +
            '","projectPath":"' + lcEsc(app.project.path) + '","sequences":' + nseq + ',"names":[' + names.join(',') + ']}';
    } catch (e) { return lcErr(e); }
}
// Save + close the project so its file can be edited (Color Mode is invisible to scripts).
// Closing the LAST open project sends Premiere to its Home screen, which unloads every panel (this one too).
// So a small blank "parking" project is opened first; the client project is then closed from behind it.
function lcOpenIndex(path) {
    var want = String(path).toLowerCase();
    for (var i = 0; i < app.projects.numProjects; i++) { if (String(app.projects[i].path).toLowerCase() === want) { return i; } }
    return -1;
}
function lcCloseForEdit(parkPath) {
    var log = [];
    try {
        var path = app.project.path;
        app.project.save(); log.push('saved');
        if (lcOpenIndex(parkPath) < 0) {
            if (new File(parkPath).exists) { app.openDocument(parkPath, true, true, true, true); log.push('park opened'); }
            else { app.newProject(parkPath); log.push('park created'); }
        }
        if (lcOpenIndex(parkPath) < 0) { return 'ERR:the blank parking project did not open (' + log.join(', ') + ')'; }
        var i = lcOpenIndex(path);
        if (i >= 0) { var ok = app.projects[i].closeDocument(true, false); log.push('close=' + ok); }
        return lcOpenIndex(path) >= 0 ? 'ERR:Premiere did not close the project (' + log.join(', ') + ')' : 'OK:' + log.join(', ');
    } catch (e) { return 'ERR:' + e.toString() + ' (' + log.join(', ') + ')'; }
}
function lcReopen(path, seqId, ticks, parkPath) {
    try {
        if (lcOpenIndex(path) < 0) { app.openDocument(path, true, true, true); }
        var p = null, i = lcOpenIndex(path);
        if (i >= 0) { p = app.projects[i]; }
        if (parkPath) {                                  // drop the blank parking project again
            var k = lcOpenIndex(parkPath);
            if (k >= 0) { try { app.projects[k].closeDocument(false, false); } catch (e2) {} }
        }
        if (!p) { return 'ERR:the project did not open'; }
        for (var j = 0; j < p.sequences.numSequences; j++) {
            if (p.sequences[j].sequenceID === seqId) {
                p.openSequence(seqId);
                try { p.activeSequence.setPlayerPosition(String(ticks)); } catch (e1) {}
                break;
            }
        }
        return 'OK';
    } catch (e) { return 'ERR:' + e.toString(); }
}

// ---------------- Review ----------------
// Body clips (enabled pieces on V1) of the active sequence, with every marker
function lcReview() {
    try {
        var s = app.project.activeSequence;
        if (!s) { return '{"error":"Open one of the client sequences first."}'; }
        var out = '{"sequence":"' + lcEsc(s.name) + '","seqId":"' + lcEsc(s.sequenceID) + '","timebase":"' + s.timebase + '","position":"' + s.getPlayerPosition().ticks + '","clips":[', first = true;
        if (s.videoTracks.numTracks > 0) {
            var t = s.videoTracks[0];
            for (var i = 0; i < t.clips.numItems; i++) {
                var c = t.clips[i];
                if (c.disabled) { continue; }
                var sel = false; try { sel = c.isSelected(); } catch (e1) {}
                out += (first ? '' : ',') + '{"name":"' + lcEsc(c.name) + '","nodeId":"' + lcEsc(c.nodeId) + '","inSec":' + c.inPoint.seconds + ',"outSec":' + c.outPoint.seconds + ',"startTicks":"' + c.start.ticks + '","endTicks":"' + c.end.ticks +
                    '","start":' + c.start.seconds + ',"end":' + c.end.seconds + ',"selected":' + (sel ? 'true' : 'false') + '}';
                first = false;
            }
        }
        out += '],"markers":[';
        var ms = s.markers, m = ms ? ms.getFirstMarker() : null; first = true;
        while (m) {
            out += (first ? '' : ',') + '{"ticks":"' + m.start.ticks + '","seconds":' + m.start.seconds + ',"name":"' + lcEsc(m.name) + '","comments":"' + lcEsc(m.comments) + '"}';
            first = false; m = ms.getNextMarker(m);
        }
        return out + ']}';
    } catch (e) { return lcErr(e); }
}
function lcGoto(ticks) {
    try { app.project.activeSequence.setPlayerPosition(String(ticks)); return 'OK'; } catch (e) { return 'ERR:' + e.toString(); }
}
// After rolling an edit point by hand: put each IN/OUT marker back on its clip's real first / last frame.
// Comments (and REVIEW notes) are kept; markers of clips that moved are rebuilt.
function lcSyncMarkers() {
    try {
        var s = app.project.activeSequence;
        if (!s) { return 'ERR:Open one of the client sequences first.'; }
        var frame = Number(s.timebase), ms = s.markers, keep = {}, m = ms.getFirstMarker(), dead = [];
        while (m) {
            var nm = String(m.name), hit = nm.match(/^(IN|OUT) (.+)$/);
            if (hit) { keep[nm] = { comments: m.comments, color: m.getColorByIndex ? m.getColorByIndex() : 0 }; dead.push(m); }
            m = ms.getNextMarker(m);
        }
        for (var d = 0; d < dead.length; d++) { ms.deleteMarker(dead[d]); }
        var t = s.videoTracks[0], n = 0, seen = {};
        for (var i = 0; i < t.clips.numItems; i++) {
            var c = t.clips[i];
            if (c.disabled || seen[c.name]) { continue; }
            seen[c.name] = true;
            var pairs = [['IN ' + c.name, Number(c.start.ticks), 'IN: mouth closed + eyes open'], ['OUT ' + c.name, Number(c.end.ticks) - frame, 'OUT: mouth closed + eyes open']];
            for (var k = 0; k < 2; k++) {
                var old = keep[pairs[k][0]], mk = ms.createMarker(pairs[k][1] / 254016000000);
                mk.name = pairs[k][0];
                mk.comments = old ? old.comments : pairs[k][2];
                try { if (old && mk.setColorByIndex) { mk.setColorByIndex(old.color); } } catch (e2) {}
                n++;
            }
        }
        return 'OK:' + n;
    } catch (e) { return 'ERR:' + e.toString(); }
}
// Still image of the frame at ticks. outPath has no extension: Premiere adds it. PNG, or JPEG when PNG is unavailable.
function lcStill(ticks, outPath) {
    try {
        var s = app.project.activeSequence;
        s.setPlayerPosition(String(ticks));
        app.enableQE();
        var q = qe.project.getActiveSequence();
        if (typeof q.exportFramePNG === 'function') { q.exportFramePNG(q.CTI.timecode, outPath); return 'OK:png'; }
        q.exportFrameJPEG(q.CTI.timecode, outPath);
        return 'OK:jpg';
    } catch (e) { return 'ERR:' + e.toString(); }
}

// ---------------- Live grade: Lumetri Basic, relative to each clip's own value ----------------
var LC_LIMITS = { temperature: [-100, 100], tint: [-100, 100], saturation: [0, 200], exposure: [-5, 5], contrast: [-100, 100],
    highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100], blacks: [-100, 100] };
function lcLumState(scope) {
    try {
        var t = lcScope(scope), n = 0, first = null;
        for (var i = 0; i < t.length; i++) { var v = lcValuesJson(t[i].clip); if (v) { n++; if (!first) { first = v; } } }
        return '{"count":' + t.length + ',"graded":' + n + ',"values":' + (first || 'null') + '}';
    } catch (e) { return lcErr(e); }
}
// csv in LC_KEYS order: a delta per slider, "x" = leave it
function lcNudge(scope, csv) {
    try {
        var d = String(csv).split(','), t = lcScope(scope), n = 0;
        for (var i = 0; i < t.length; i++) {
            var l = lcLumetri(t[i].clip); if (!l) { continue; }
            var b = lcBasic(l);
            for (var k = 0; k < LC_KEYS.length; k++) {
                if (d[k] === 'x' || d[k] === undefined || !b[LC_KEYS[k]]) { continue; }
                var lim = LC_LIMITS[LC_KEYS[k]], v = lcRound(b[LC_KEYS[k]].getValue() + parseFloat(d[k]));
                b[LC_KEYS[k]].setValue(Math.max(lim[0], Math.min(lim[1], v)), true);
            }
            n++;
        }
        return lcLumState(scope);
    } catch (e) { return lcErr(e); }
}

// ---------------- Green screen removal: Ultra Key ----------------
var LC_KEY_PARAMS = ['Tolerance', 'Pedestal', 'Choke', 'Soften', 'Spill'];
function lcUltra(clip) {
    for (var i = 0; i < clip.components.numItems; i++) { if (clip.components[i].matchName === 'AE.ADBE Ultra Key') { return clip.components[i]; } }
    return null;
}
function lcProp(comp, name) {
    for (var i = 0; i < comp.properties.numItems; i++) { if (comp.properties[i].displayName === name) { return comp.properties[i]; } }
    return null;
}
function lcKeyState(scope) {
    try {
        var t = lcScope(scope), keyed = 0, first = null;
        for (var i = 0; i < t.length; i++) {
            var u = lcUltra(t[i].clip); if (!u) { continue; }
            keyed++;
            if (!first) {
                first = '{';
                for (var k = 0; k < LC_KEY_PARAMS.length; k++) { var pr = lcProp(u, LC_KEY_PARAMS[k]); first += (k ? ',' : '') + '"' + LC_KEY_PARAMS[k] + '":' + (pr ? lcRound(pr.getValue()) : 'null'); }
                first += '}';
            }
        }
        return '{"count":' + t.length + ',"keyed":' + keyed + ',"values":' + (first || 'null') + '}';
    } catch (e) { return lcErr(e); }
}
// Clips in scope with a frame time to sample: [{seqId, index, name, ticks}]
function lcKeyTargets(scope) {
    try {
        var t = lcScope(scope), out = [];
        for (var i = 0; i < t.length; i++) {
            var c = t[i].clip, mid = (Number(c.start.ticks) + Number(c.end.ticks)) / 2;
            var at = Math.min(Number(c.start.ticks) + 254016000000 * 2, mid);       // 2 s in, or the middle of a short clip
            out.push('{"seqId":"' + lcEsc(t[i].seq.sequenceID) + '","index":' + t[i].index + ',"name":"' + lcEsc(c.name) + '","ticks":"' + Math.round(at) + '","keyed":' + (lcUltra(c) ? 'true' : 'false') + '}');
        }
        return '[' + out.join(',') + ']';
    } catch (e) { return lcErr(e); }
}
// ---------------- Light check: one clip at a time ----------------
// Clips in scope with a mid-clip frame and their current Lumetri values: [{seqId, index, name, ticks, values}]
function lcLightTargets(scope) {
    try {
        var t = lcScope(scope), out = [], seen = {};
        for (var i = 0; i < t.length; i++) {
            var c = t[i].clip, k = t[i].seq.sequenceID + '|' + t[i].index;
            if (seen[k]) { continue; }
            seen[k] = true;
            var mid = Math.round((Number(c.start.ticks) + Number(c.end.ticks)) / 2);
            out.push('{"seqId":"' + lcEsc(t[i].seq.sequenceID) + '","index":' + t[i].index + ',"name":"' + lcEsc(c.name) + '","ticks":"' + mid + '","values":' + (lcValuesJson(c) || 'null') + '}');
        }
        return '[' + out.join(',') + ']';
    } catch (e) { return lcErr(e); }
}
// relative nudge on ONE clip (csv in LC_KEYS order, "x" = leave); returns its new values
function lcNudgeAt(seqId, index, csv) {
    try {
        var s = lcSeqById(seqId); if (!s) { return '{"error":"sequence not found"}'; }
        var c = s.videoTracks[0].clips[index], l = c ? lcLumetri(c) : null;
        if (!l) { return '{"error":"no Lumetri on this clip"}'; }
        var d = String(csv).split(','), b = lcBasic(l);
        for (var k = 0; k < LC_KEYS.length; k++) {
            if (d[k] === 'x' || d[k] === undefined || d[k] === '' || !b[LC_KEYS[k]]) { continue; }
            var lim = LC_LIMITS[LC_KEYS[k]], v = lcRound(b[LC_KEYS[k]].getValue() + parseFloat(d[k]));
            b[LC_KEYS[k]].setValue(Math.max(lim[0], Math.min(lim[1], v)), true);
        }
        return lcValuesJson(c);
    } catch (e) { return lcErr(e); }
}
function lcSeqById(id) {
    var p = app.project;
    for (var i = 0; i < p.sequences.numSequences; i++) { if (p.sequences[i].sequenceID === id) { return p.sequences[i]; } }
    return null;
}
// still of one sequence position (opens that sequence first)
function lcStillIn(seqId, ticks, outPath) {
    try {
        var act = app.project.activeSequence;
        if (!act || act.sequenceID !== seqId) { app.project.openSequence(seqId); }
        return lcStill(ticks, outPath);
    } catch (e) { return 'ERR:' + e.toString(); }
}
// the QE item for DOM clip index on V1 (QE also lists the empty gaps)
function lcQeItem(seqId, index) {
    var act = app.project.activeSequence;
    if (!act || act.sequenceID !== seqId) { app.project.openSequence(seqId); }
    app.enableQE();
    var qt = qe.project.getActiveSequence().getVideoTrackAt(0), n = -1;
    for (var i = 0; i < qt.numItems; i++) {
        var it = qt.getItemAt(i);
        if (it.type === 'Empty') { continue; }
        n++;
        if (n === index) { return it; }
    }
    return null;
}
function lcKeyAdd(seqId, index, r, g, b, paramsCsv) {
    try {
        var s = lcSeqById(seqId); if (!s) { return 'ERR:sequence not found'; }
        var clip = s.videoTracks[0].clips[index];
        if (!lcUltra(clip)) {
            var it = lcQeItem(seqId, index); if (!it) { return 'ERR:clip not found'; }
            it.addVideoEffect(qe.project.getVideoEffectByName('Ultra Key'));
        }
        var u = lcUltra(clip); if (!u) { return 'ERR:Ultra Key was not added'; }
        var kc = lcProp(u, 'Key Color'); if (kc) { kc.setColorValue(255, r, g, b, true); }
        var v = String(paramsCsv || '').split(',');
        for (var k = 0; k < LC_KEY_PARAMS.length; k++) {
            if (v[k] === undefined || v[k] === '' || v[k] === 'x') { continue; }
            var pr = lcProp(u, LC_KEY_PARAMS[k]); if (pr) { pr.setValue(parseFloat(v[k]), true); }
        }
        return 'OK';
    } catch (e) { return 'ERR:' + e.toString(); }
}
function lcKeyRemove(scope) {
    try {
        var t = lcScope(scope), n = 0, back = app.project.activeSequence ? app.project.activeSequence.sequenceID : '';
        for (var i = 0; i < t.length; i++) {
            if (!lcUltra(t[i].clip)) { continue; }
            var it = lcQeItem(t[i].seq.sequenceID, t[i].index); if (!it) { continue; }
            for (var j = it.numComponents - 1; j >= 0; j--) {
                var c = it.getComponentAt(j);
                if (c && c.name === 'Ultra Key') { c.remove(); n++; }
            }
        }
        if (back) { app.project.openSequence(back); }
        return 'OK:' + n;
    } catch (e) { return 'ERR:' + e.toString(); }
}
function lcKeySet(scope, name, delta) {
    try {
        var t = lcScope(scope), n = 0;
        for (var i = 0; i < t.length; i++) {
            var u = lcUltra(t[i].clip); if (!u) { continue; }
            var pr = lcProp(u, name); if (!pr) { continue; }
            pr.setValue(Math.max(0, Math.min(100, lcRound(pr.getValue() + parseFloat(delta)))), true); n++;
        }
        return lcKeyState(scope);
    } catch (e) { return lcErr(e); }
}
function lcOpenSeq(seqId) { try { if (seqId) { app.project.openSequence(seqId); } return 'OK'; } catch (e) { return 'ERR:' + e.toString(); } }


// ---------------- Review: focus a clip by its timeline id (not its file name) ----------------
function lcFocus(seqId, nodeId) {
    try {
        var s = lcSeqById(seqId);
        if (!s) { return 'ERR:sequence not found'; }
        if (!app.project.activeSequence || app.project.activeSequence.sequenceID !== seqId) { app.project.openSequence(seqId); s = app.project.activeSequence; }
        var t = s.videoTracks[0], hit = null;
        for (var i = 0; i < t.clips.numItems; i++) {
            var c = t.clips[i];
            try { c.setSelected(c.nodeId === nodeId, true); } catch (e1) {}
            if (c.nodeId === nodeId) { hit = c; }
        }
        if (!hit) { return 'ERR:clip not found (the timeline changed: press Refresh)'; }
        s.setPlayerPosition(String(hit.start.ticks));
        return 'OK';
    } catch (e) { return 'ERR:' + e.toString(); }
}
// Learning baseline: source IN / OUT (seconds) of every clip's used part, all sequences: { "<clip>": {in, out} }
// The used part = enabled V1 pieces of one media file (first IN, last OUT).
function lcAllCuts() {
    try {
        var p = app.project, out = {}, parts = [];
        for (var i = 0; i < p.sequences.numSequences; i++) {
            var s = p.sequences[i];
            if (s.videoTracks.numTracks < 1) { continue; }
            var t = s.videoTracks[0];
            for (var c = 0; c < t.clips.numItems; c++) {
                var k = t.clips[c];
                if (k.disabled) { continue; }
                var o = out[k.name];
                if (!o) { out[k.name] = { a: k.inPoint.seconds, b: k.outPoint.seconds }; }
                else { o.a = Math.min(o.a, k.inPoint.seconds); o.b = Math.max(o.b, k.outPoint.seconds); }
            }
        }
        for (var n in out) { parts.push('"' + lcEsc(n) + '":{"in":' + lcRound(out[n].a) + ',"out":' + lcRound(out[n].b) + '}'); }
        return '{' + parts.join(',') + '}';
    } catch (e) { return lcErr(e); }
}

// ---------------- Grade: copy / paste ----------------
// Copy: the first selected enabled V1 clip in the open sequence -> {"name", "lumetri":{...}}
function lcCopySource() {
    try {
        var t = lcScope('selected');
        if (!t.length) { return '{"error":"Select the graded clip in the timeline first."}'; }
        var v = lcValuesJson(t[0].clip);
        return '{"name":"' + lcEsc(t[0].clip.name) + '","lumetri":' + (v || 'null') + ',"projectPath":"' + lcEsc(app.project.path) + '"}';
    } catch (e) { return lcErr(e); }
}
// Paste Lumetri: absolute Basic Correction values (csv in LC_KEYS order, 'x' = leave) on every selected clip except the source
function lcPasteLum(csv, exclude) {
    try {
        var d = String(csv).split(','), t = lcScope('selected'), n = 0, missing = 0;
        for (var i = 0; i < t.length; i++) {
            if (t[i].clip.name === exclude) { continue; }
            var l = lcLumetri(t[i].clip); if (!l) { missing++; continue; }
            var b = lcBasic(l);
            for (var k = 0; k < LC_KEYS.length; k++) {
                if (d[k] === 'x' || d[k] === undefined || !b[LC_KEYS[k]]) { continue; }
                b[LC_KEYS[k]].setValue(parseFloat(d[k]), true);
            }
            n++;
        }
        return '{"pasted":' + n + ',"noLumetri":' + missing + '}';
    } catch (e) { return lcErr(e); }
}

// ---------------- Undo / Redo (Premiere's own history, via QE) ----------------
// dir: 'undo' | 'redo'. Returns OK:<moved>; moved 0 = nothing to undo / redo.
function uaiHistory(dir) {
    try {
        app.enableQE();
        var p = qe.project, before = null, after = null;
        try { before = Number(p.undoStackIndex()); } catch (e1) {}
        if (dir === 'redo') { p.redo(); } else { p.undo(); }
        try { after = Number(p.undoStackIndex()); } catch (e2) {}
        return 'OK:' + (before === null || after === null ? '?' : Math.abs(after - before));
    } catch (e) { return 'ERR:' + e.toString(); }
}

// ---------------- Proxies ----------------
// Every clip in the project that points at a media file, in every bin, with whether a proxy is attached.
function lcProxyList() {
    try {
        if (!app.project || !app.project.path) { return '{"open":false}'; }
        var out = [], stack = [app.project.rootItem];
        while (stack.length) {
            var bin = stack.pop();
            for (var i = 0; i < bin.children.numItems; i++) {
                var it = bin.children[i];
                if (it.type === ProjectItemType.BIN) { stack.push(it); continue; }
                if (it.type !== ProjectItemType.CLIP) { continue; }
                var media = '', has = false;
                try { media = it.getMediaPath(); } catch (e1) {}
                if (!media) { continue; }
                try { has = it.hasProxy(); } catch (e2) {}
                out.push('{"id":"' + lcEsc(it.nodeId) + '","name":"' + lcEsc(it.name) + '","media":"' + lcEsc(media) + '","has":' + (has ? 'true' : 'false') + '}');
            }
        }
        var on = false;
        try { on = !!app.getEnableProxies(); } catch (e3) {}
        return '{"open":true,"enabled":' + (on ? 'true' : 'false') + ',"items":[' + out.join(',') + ']}';
    } catch (e) { return lcErr(e); }
}
function lcFindItem(nodeId) {
    var stack = [app.project.rootItem];
    while (stack.length) {
        var bin = stack.pop();
        for (var i = 0; i < bin.children.numItems; i++) {
            var it = bin.children[i];
            if (it.nodeId === nodeId) { return it; }
            if (it.type === ProjectItemType.BIN) { stack.push(it); }
        }
    }
    return null;
}
function lcProxyAttach(nodeId, proxyPath) {
    try {
        var it = lcFindItem(nodeId);
        if (!it) { return 'ERR:clip is no longer in the project'; }
        it.attachProxy(proxyPath, 0);
        return it.hasProxy() ? 'OK' : 'ERR:Premiere did not accept the proxy';
    } catch (e) { return 'ERR:' + e.toString(); }
}
// on: 1 shows proxies in every monitor (app-wide), 0 shows the originals
function lcProxyShow(on) {
    try { app.setEnableProxies(on ? 1 : 0); return app.getEnableProxies() ? 'OK:1' : 'OK:0'; } catch (e) { return 'ERR:' + e.toString(); }
}
