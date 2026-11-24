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
        var out = '{"sequence":"' + lcEsc(s.name) + '","timebase":"' + s.timebase + '","position":"' + s.getPlayerPosition().ticks + '","clips":[', first = true;
        if (s.videoTracks.numTracks > 0) {
            var t = s.videoTracks[0];
            for (var i = 0; i < t.clips.numItems; i++) {
                var c = t.clips[i];
                if (c.disabled) { continue; }
                var sel = false; try { sel = c.isSelected(); } catch (e1) {}
                out += (first ? '' : ',') + '{"name":"' + lcEsc(c.name) + '","startTicks":"' + c.start.ticks + '","endTicks":"' + c.end.ticks +
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

// ---------------- Scoped cut (Build: Current sequence / Selected clip) ----------------
// Cuts in place on the timeline, so the grade already on a clip (Lumetri, Color Mode, key) stays.
// A clip = the run of V1 items from one media file: one uncut item, or head | body | tail.
var LC_TPS = 254016000000;
function lcMediaPath(item) { try { return item.projectItem ? String(item.projectItem.getMediaPath()) : ''; } catch (e) { return ''; } }
function lcGroup(track, mpath) {
    var out = [];
    for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        if (lcMediaPath(c) === mpath) { out.push(c); }
    }
    return out;
}
// Clips in scope: 'sequence' = every clip in the open sequence; 'selected' = clips with any piece selected
// in the open sequence, plus clips named in namesCsv (ticked in the panel list) in any sequence.
function lcCutTargets(scope, namesJson) {
    try {
        var p = app.project, act = p.activeSequence, want = {}, out = [], seen = {}, i, j, n = 0;
        var names = []; try { names = eval('(' + namesJson + ')') || []; } catch (e0) {}
        for (i = 0; i < names.length; i++) { want[names[i]] = true; n++; }
        if (!act && !n) { return '{"error":"Open one of the client sequences first."}'; }
        var scan = function (s, onlyNamed) {
            if (!s || s.videoTracks.numTracks < 1) { return; }
            var t = s.videoTracks[0];
            for (j = 0; j < t.clips.numItems; j++) {
                var c = t.clips[j], mp = lcMediaPath(c);
                if (!mp) { continue; }
                var key = s.sequenceID + '|' + mp, sel = false;
                try { sel = c.isSelected(); } catch (e1) {}
                var hit = onlyNamed ? !!want[c.name] : (scope === 'sequence' || sel || !!want[c.name]);
                if (!hit || seen[key]) { continue; }
                seen[key] = true;
                out.push('{"seqId":"' + lcEsc(s.sequenceID) + '","sequence":"' + lcEsc(s.name) + '","name":"' + lcEsc(c.name) + '","path":"' + lcEsc(mp) + '","pieces":' + lcGroup(t, mp).length + '}');
            }
        };
        scan(act, false);
        if (n) { for (i = 0; i < p.sequences.numSequences; i++) { if (!act || p.sequences[i].sequenceID !== act.sequenceID) { scan(p.sequences[i], true); } } }
        return '{"sequence":"' + (act ? lcEsc(act.name) : '') + '","clips":[' + out.join(',') + ']}';
    } catch (e) { return lcErr(e); }
}
function lcTc(seq, ticks) {
    var tb = Number(seq.timebase), f = Math.round(Number(ticks) / tb), fmt = 100;
    try { fmt = seq.getSettings().videoDisplayFormat; } catch (e) {}
    try { var fr = new Time(); fr.ticks = String(tb); var t = new Time(); t.ticks = String(f * tb); return t.getFormatted(fr, fmt); } catch (e2) {}
    var nom = Math.round(LC_TPS / tb), pad = function (v) { return (v < 10 ? '0' : '') + v; };
    return pad(Math.floor(f / (nom * 3600))) + ':' + pad(Math.floor(f / (nom * 60)) % 60) + ':' + pad(Math.floor(f / nom) % 60) + ':' + pad(f % nom);
}
function lcSetT(item, prop, ticks) { var t = new Time(); t.ticks = String(Math.round(ticks)); item[prop] = t; }
// Move the cut between pieces a | b to newCut (timeline ticks); source points follow. The shrinking side goes first.
function lcRoll(a, b, newCut) {
    var old = Number(a.end.ticks), d = newCut - old;
    if (!d) { return; }
    if (newCut <= Number(a.start.ticks) || newCut >= Number(b.end.ticks)) { throw new Error('the new cut falls outside ' + a.name); }
    var aOut = Number(a.outPoint.ticks) + d, bIn = Number(b.inPoint.ticks) + d;
    if (d > 0) { lcSetT(b, 'start', newCut); b.inPoint = String(Math.round(bIn)); lcSetT(a, 'end', newCut); a.outPoint = String(Math.round(aOut)); }
    else { lcSetT(a, 'end', newCut); a.outPoint = String(Math.round(aOut)); lcSetT(b, 'start', newCut); b.inPoint = String(Math.round(bIn)); }
}
// inSec / outSec: source seconds of the body (out exclusive). Works on V1 and A1.
function lcCutApply(seqId, mpath, inSec, outSec, flag) {
    try {
        var s = lcSeqById(seqId);
        if (!s) { return 'ERR:sequence not found'; }
        if (!app.project.activeSequence || app.project.activeSequence.sequenceID !== seqId) { app.project.openSequence(seqId); }
        s = app.project.activeSequence;
        var tb = Number(s.timebase), snap = function (v) { return Math.round(v / tb) * tb; };
        app.enableQE();
        var qs = qe.project.getActiveSequence(), done = 0, body = null, tIn = 0, tOut = 0;
        var tracks = [[s.videoTracks[0], function () { return qs.getVideoTrackAt(0); }], [s.audioTracks.numTracks ? s.audioTracks[0] : null, function () { return qs.getAudioTrackAt(0); }]];
        for (var k = 0; k < tracks.length; k++) {
            var tr = tracks[k][0];
            if (!tr) { continue; }
            var g = lcGroup(tr, mpath);
            if (!g.length) { continue; }
            var gStart = Number(g[0].start.ticks), gEnd = Number(g[g.length - 1].end.ticks), src0 = Number(g[0].inPoint.ticks);
            tIn = snap(gStart + inSec * LC_TPS - src0); tOut = snap(gStart + outSec * LC_TPS - src0);
            tIn = Math.max(gStart, Math.min(gEnd - tb, tIn)); tOut = Math.max(tIn + tb, Math.min(gEnd, tOut));
            var want = [];
            if (tIn > gStart) { want.push(tIn); }
            if (tOut < gEnd) { want.push(tOut); }
            if (g.length === 1) {
                for (var w = 0; w < want.length; w++) {
                    var before = lcGroup(tr, mpath).length;
                    tracks[k][1]().razor(lcTc(s, want[w]));
                    if (lcGroup(tr, mpath).length === before) { throw new Error('Premiere did not cut ' + g[0].name + ' (razor no-op)'); }
                }
            } else if (g.length - 1 === want.length) {
                // head|body|tail (or head|body / body|tail): roll each cut; when the IN moves past the old OUT, roll the OUT first
                if (want.length === 2 && want[0] >= Number(g[1].end.ticks)) { lcRoll(g[1], g[2], want[1]); lcRoll(g[0], g[1], want[0]); }
                else { for (var r = 0; r < want.length; r++) { lcRoll(g[r], g[r + 1], want[r]); } }
            } else {
                throw new Error(g[0].name + ' is cut into ' + g.length + ' pieces on the timeline; use All sequences to rebuild it');
            }
            var pieces = lcGroup(tr, mpath);
            for (var p2 = 0; p2 < pieces.length; p2++) {
                var it = pieces[p2], on = Number(it.start.ticks) >= tIn - tb / 2 && Number(it.end.ticks) <= tOut + tb / 2;
                it.disabled = !on;
                if (on && k === 0) { body = it; }
            }
            done++;
        }
        if (!body) { return 'ERR:clip not found on V1 of ' + s.name; }
        // IN / OUT markers for this clip
        var ms = s.markers, m = ms.getFirstMarker(), dead = [], nm = String(body.name);
        while (m) { if (m.name === 'IN ' + nm || m.name === 'OUT ' + nm) { dead.push(m); } m = ms.getNextMarker(m); }
        for (var d = 0; d < dead.length; d++) { ms.deleteMarker(dead[d]); }
        var mi = ms.createMarker(Number(body.start.ticks) / LC_TPS); mi.name = 'IN ' + nm; mi.comments = 'IN: mouth closed + eyes open';
        var mo = ms.createMarker((Number(body.end.ticks) - tb) / LC_TPS); mo.name = 'OUT ' + nm; mo.comments = flag ? 'OUT REVIEW: ' + flag : 'OUT: mouth closed + eyes open';
        return '{"ok":true,"tracks":' + done + ',"startTicks":"' + body.start.ticks + '","endTicks":"' + body.end.ticks + '","seconds":' + lcRound(body.end.seconds - body.start.seconds) + '}';
    } catch (e) { return lcErr(e); }
}
