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
            out += '{"id":"' + ugEsc(s.sequenceID) + '","name":"' + ugEsc(s.name) + '","w":' + s.frameSizeHorizontal + ',"h":' + s.frameSizeVertical + ',"clips":[';
            var first = true;
            if (s.videoTracks.numTracks > 0) {
                var t = s.videoTracks[0];
                for (var c = 0; c < t.clips.numItems; c++) {
                    var k = t.clips[c];
                    var sel = false;
                    try { sel = k.isSelected(); } catch (e1) {}
                    if (!first) { out += ','; }
                    first = false;
                    out += '{"name":"' + ugEsc(k.name) + '","start":' + k.start.seconds + ',"end":' + k.end.seconds + ',"enabled":' + (k.disabled ? 'false' : 'true') + ',"selected":' + (sel ? 'true' : 'false') + '}';
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
