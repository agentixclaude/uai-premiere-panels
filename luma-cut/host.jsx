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
function lcGradeRead(scope) {
    try {
        var t = lcTargets(scope, ''), graded = 0, first = null, firstName = '';
        for (var i = 0; i < t.length; i++) {
            var v = lcValuesJson(t[i]);
            if (v) { graded++; if (!first) { first = v; firstName = t[i].name; } }
        }
        return '{"count":' + t.length + ',"graded":' + graded + ',"name":"' + lcEsc(firstName) + '","camera":"' + lcEsc(firstName ? lcCamera(firstName) : '') + '","values":' + (first || 'null') + '}';
    } catch (e) { return lcErr(e); }
}
function lcGradeNudge(scope, key, delta) {
    try {
        var t = lcTargets(scope, '');
        for (var i = 0; i < t.length; i++) {
            var l = lcLumetri(t[i]); if (!l) { continue; }
            var p = lcBasic(l)[key]; if (!p) { continue; }
            p.setValue(lcRound(p.getValue() + delta), true);
        }
        return lcGradeRead(scope);
    } catch (e) { return lcErr(e); }
}
function lcGradeApply(scope, cam, csv) {
    try {
        var vals = String(csv).split(','), t = lcTargets(scope, cam), n = 0;
        for (var i = 0; i < t.length; i++) {
            var l = lcLumetri(t[i]); if (!l) { continue; }
            var b = lcBasic(l);
            for (var k = 0; k < LC_KEYS.length; k++) {
                if (vals[k] === 'x' || vals[k] === undefined || !b[LC_KEYS[k]]) { continue; }
                b[LC_KEYS[k]].setValue(parseFloat(vals[k]), true);
            }
            n++;
        }
        return 'OK:' + n;
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
// outPath has no extension: Premiere adds .jpg itself
function lcStill(ticks, outPath) {
    try {
        var s = app.project.activeSequence;
        s.setPlayerPosition(String(ticks));
        app.enableQE();
        var q = qe.project.getActiveSequence();
        q.exportFrameJPEG(q.CTI.timecode, outPath);
        return 'OK';
    } catch (e) { return 'ERR:' + e.toString(); }
}
