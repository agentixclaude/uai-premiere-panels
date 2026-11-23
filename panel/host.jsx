// UAI Smart Export — Premiere host script (ExtendScript, ES3)
function ugEsc(s) {
    s = String(s);
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ');
}
function ugFindSeq(id) {
    var p = app.project;
    for (var i = 0; i < p.sequences.numSequences; i++) {
        if (p.sequences[i].sequenceID === id) { return p.sequences[i]; }
    }
    return null;
}
// Project + every sequence + every clip on V1 (name, range, enabled, selected)
function ugInfo() {
    try {
        var p = app.project;
        if (!p || !p.path) { return '{"error":"Open a saved project first."}'; }
        var act = p.activeSequence;
        var out = '{"projectPath":"' + ugEsc(p.path) + '","projectName":"' + ugEsc(p.name) + '","activeId":"' + (act ? ugEsc(act.sequenceID) : '') + '","sequences":[';
        for (var i = 0; i < p.sequences.numSequences; i++) {
            var s = p.sequences[i];
            if (i > 0) { out += ','; }
            out += '{"id":"' + ugEsc(s.sequenceID) + '","name":"' + ugEsc(s.name) + '","w":' + s.frameSizeHorizontal + ',"h":' + s.frameSizeVertical + ',"timebase":"' + s.timebase + '","clips":[';
            var first = true;
            if (s.videoTracks.numTracks > 0) {
                var t = s.videoTracks[0];
                for (var c = 0; c < t.clips.numItems; c++) {
                    var k = t.clips[c];
                    var sel = false;
                    try { sel = k.isSelected(); } catch (e1) {}
                    if (!first) { out += ','; }
                    first = false;
                    out += '{"name":"' + ugEsc(k.name) + '","start":' + k.start.seconds + ',"end":' + k.end.seconds + ',"startTicks":"' + k.start.ticks + '","endTicks":"' + k.end.ticks + '","inPoint":' + k.inPoint.seconds + ',"outPoint":' + k.outPoint.seconds + ',"enabled":' + (k.disabled ? 'false' : 'true') + ',"selected":' + (sel ? 'true' : 'false') + '}';
                }
            }
            out += ']}';
        }
        return out + ']}';
    } catch (e) {
        return '{"error":"' + ugEsc(e.toString()) + '"}';
    }
}
function ugGetInOut(seqId) {
    try {
        var s = ugFindSeq(seqId);
        return s ? (s.getInPoint() + '|' + s.getOutPoint()) : '';
    } catch (e) { return ''; }
}
function ugSetInOut(seqId, inSec, outSec) {
    try {
        var s = ugFindSeq(seqId);
        if (s) { s.setInPoint(inSec); s.setOutPoint(outSec); }
        return 'OK';
    } catch (e) { return 'ERR:' + e.toString(); }
}
// One Media Encoder job for one clip range of a sequence
function ugQueue(seqId, inSec, outSec, outPath, presetPath) {
    try {
        var s = ugFindSeq(seqId);
        if (!s) { return 'ERR:sequence not found'; }
        s.setInPoint(inSec);
        s.setOutPoint(outSec);
        app.encoder.launchEncoder();
        var job = app.encoder.encodeSequence(s, outPath, presetPath, app.encoder.ENCODE_IN_TO_OUT, 0);
        return job ? ('OK:' + job) : 'ERR:Media Encoder did not accept the job';
    } catch (e) {
        return 'ERR:' + e.toString();
    }
}
function ugStartQueue() {
    try { app.encoder.startBatch(); return 'OK'; } catch (e) { return 'ERR:' + e.toString(); }
}
function ugPickFolder(startPath) {
    try {
        var start = startPath ? new Folder(startPath) : null;
        var f = start && start.exists ? start.selectDlg('Choose the export folder') : Folder.selectDialog('Choose the export folder');
        return f ? f.fsName : '';
    } catch (e) { return ''; }
}

// ---------------- Grade (first Lumetri Color on the clip = the main grade) ----------------
var UG_KEYS = ['temperature', 'tint', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
var UG_NAMES = ['Temperature', 'Tint', 'Saturation', 'Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks'];
function ugLumetri(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
        if (clip.components[i].matchName === 'AE.ADBE Lumetri') { return clip.components[i]; }
    }
    return null;
}
// Basic Correction sliders: first match of each name between "Basic Correction" and "Creative"
function ugBasic(comp) {
    var map = {}, inBasic = false, n = comp.properties.numItems;
    for (var i = 0; i < n; i++) {
        var d = comp.properties[i].displayName;
        if (d === 'Basic Correction') { inBasic = true; continue; }
        if (d === 'Creative') { break; }
        if (!inBasic) { continue; }
        for (var k = 0; k < UG_NAMES.length; k++) {
            if (d === UG_NAMES[k] && map[UG_KEYS[k]] === undefined) { map[UG_KEYS[k]] = comp.properties[i]; }
        }
    }
    return map;
}
function ugCamera(name) {
    var stem = String(name).replace(/\.[^.]+$/, '');
    var m = stem.match(/^([A-Za-z]+\d*)[-_ ]/);
    if (m) { return m[1].toUpperCase(); }
    m = stem.match(/^([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : stem.toUpperCase();
}
function ugTargets(scope, cam) {
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
            if (scope === 'camera' && ugCamera(c.name) !== cam) { continue; }
            out.push(c);
        }
    }
    return out;
}
function ugRound(v) { return Math.round(v * 100) / 100; }
function ugValuesJson(clip) {
    var l = ugLumetri(clip);
    if (!l) { return null; }
    var b = ugBasic(l), out = '{';
    for (var k = 0; k < UG_KEYS.length; k++) {
        var p = b[UG_KEYS[k]];
        out += (k ? ',' : '') + '"' + UG_KEYS[k] + '":' + (p ? ugRound(p.getValue()) : 'null');
    }
    return out + '}';
}
function ugGradeRead(scope) {
    try {
        var t = ugTargets(scope, ''), graded = 0, first = null, firstName = '';
        for (var i = 0; i < t.length; i++) {
            var v = ugValuesJson(t[i]);
            if (v) { graded++; if (!first) { first = v; firstName = t[i].name; } }
        }
        return '{"count":' + t.length + ',"graded":' + graded + ',"name":"' + ugEsc(firstName) + '","camera":"' + ugEsc(firstName ? ugCamera(firstName) : '') + '","values":' + (first || 'null') + '}';
    } catch (e) { return '{"error":"' + ugEsc(e.toString()) + '"}'; }
}
function ugGradeNudge(scope, key, delta) {
    try {
        var t = ugTargets(scope, ''), n = 0;
        for (var i = 0; i < t.length; i++) {
            var l = ugLumetri(t[i]); if (!l) { continue; }
            var p = ugBasic(l)[key]; if (!p) { continue; }
            p.setValue(ugRound(p.getValue() + delta), true); n++;
        }
        return ugGradeRead(scope);
    } catch (e) { return '{"error":"' + ugEsc(e.toString()) + '"}'; }
}
// values in UG_KEYS order; "x" = leave that slider alone
function ugGradeApply(scope, cam, csv) {
    try {
        var vals = String(csv).split(','), t = ugTargets(scope, cam), n = 0;
        for (var i = 0; i < t.length; i++) {
            var l = ugLumetri(t[i]); if (!l) { continue; }
            var b = ugBasic(l);
            for (var k = 0; k < UG_KEYS.length; k++) {
                if (vals[k] === 'x' || vals[k] === undefined || !b[UG_KEYS[k]]) { continue; }
                b[UG_KEYS[k]].setValue(parseFloat(vals[k]), true);
            }
            n++;
        }
        return 'OK:' + n;
    } catch (e) { return 'ERR:' + e.toString(); }
}
// ---------------- Review ----------------
function ugMarkers() {
    try {
        var s = app.project.activeSequence;
        if (!s) { return '{"error":"Open a sequence first."}'; }
        var out = '{"sequence":"' + ugEsc(s.name) + '","position":"' + s.getPlayerPosition().ticks + '","markers":[', ms = s.markers, first = true;
        var m = ms ? ms.getFirstMarker() : null;
        while (m) {
            out += (first ? '' : ',') + '{"ticks":"' + m.start.ticks + '","seconds":' + m.start.seconds + ',"name":"' + ugEsc(m.name) + '","comments":"' + ugEsc(m.comments) + '"}';
            first = false;
            m = ms.getNextMarker(m);
        }
        return out + ']}';
    } catch (e) { return '{"error":"' + ugEsc(e.toString()) + '"}'; }
}
function ugGoto(ticks) {
    try { app.project.activeSequence.setPlayerPosition(String(ticks)); return 'OK'; } catch (e) { return 'ERR:' + e.toString(); }
}
// outPath has no extension: Premiere adds it. PNG, or JPEG when PNG is unavailable.
function ugStill(ticks, outPath) {
    try {
        var s = app.project.activeSequence;
        s.setPlayerPosition(String(ticks));
        app.enableQE();
        var q = qe.project.getActiveSequence();
        if (typeof q.exportFramePNG === 'function') { q.exportFramePNG(q.CTI.timecode, outPath); return 'OK'; }
        q.exportFrameJPEG(q.CTI.timecode, outPath);
        return 'OK';
    } catch (e) { return 'ERR:' + e.toString(); }
}
// ---------------- Setup ----------------
function ugColumns(xml) {
    try { app.project.setProjectPanelMetadata(xml); return 'OK'; } catch (e) { return 'ERR:' + e.toString(); }
}
