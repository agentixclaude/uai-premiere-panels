/* UAI Luma Cut — duplicate check by content, never by file name.
   1. Identical file: same byte size + same sampled hash, then a full SHA-1 to confirm -> the copy is skipped.
   2. Same recording, different file (re-encode, re-wrap): duration within 1.5 s, same frame shape (any resolution), and
      5 time-aligned tiny frames + 5 short audio envelopes match -> both kept, flagged "check".
   3. Anything else is a different take, whatever its name ("CAM2-4309 (1).MP4" included).
   All decoding runs in ffmpeg child processes (never on the panel thread), one file at a time.
   Results are cached per file identity (path + size + modified time) in ~/UAI Luma Cut/dupe_cache.json. */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');

var POINTS = [0.1, 0.25, 0.4, 0.55, 0.7];
var FW = 32, FH = 18;                  // fingerprint frame (grey)
var V_SAME = 6;                        // mean abs difference (0-255) under which two frames are the same picture
var A_SAME = 0.9;                      // audio envelope correlation over which two windows are the same sound
var DUR_TOL = 1.5;                     // seconds

function idOf(st) { return st.size + ':' + Math.round(st.mtimeMs); }
function loadCache(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; } }
function saveCache(file, cache) {
  try { var tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, file); } catch (e) {}
}

// hash of 16 x 1 MB spread over the file + its size (fast, reads ~16 MB, async)
async function sampleHash(p, size) {
  var h = crypto.createHash('sha1'), fh = await fs.promises.open(p, 'r'), buf = Buffer.alloc(1 << 20);
  try {
    h.update(String(size));
    for (var i = 0; i < 16; i++) {
      var pos = Math.max(0, Math.floor((size - buf.length) * i / 15));
      var r = await fh.read(buf, 0, buf.length, pos);
      h.update(buf.slice(0, r.bytesRead));
    }
  } finally { await fh.close(); }
  return h.digest('hex');
}
function fullHash(p) {
  return new Promise(function (resolve, reject) {
    var h = crypto.createHash('sha1'), s = fs.createReadStream(p, { highWaterMark: 4 << 20 });
    s.on('data', function (d) { h.update(d); }); s.on('error', reject); s.on('end', function () { resolve(h.digest('hex')); });
  });
}
function run(ffmpeg, args) {
  return new Promise(function (resolve) {
    cp.execFile(ffmpeg, args, { encoding: 'buffer', maxBuffer: 8 << 20 }, function (err, out) { resolve(err ? null : out); });
  });
}
// sound first: 5 x 3 s RMS envelopes, time-aligned (fast: no picture decode)
async function soundPrint(ffmpeg, p, dur) {
  var a = [];
  for (var i = 0; i < POINTS.length; i++) {
    var au = await run(ffmpeg, ['-v', 'error', '-ss', (dur * POINTS[i]).toFixed(3), '-t', '3', '-i', p, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    var env = [];
    if (au) { for (var k = 0; k + 320 <= au.length; k += 320) { var s = 0; for (var j = k; j < k + 320; j += 2) { var x = au.readInt16LE(j) / 32768; s += x * x; } env.push(Math.round(1000 * Math.sqrt(s / 160))); } }
    a.push(env);
  }
  return a;
}
// pictures only for pairs whose sound already matches: nearest keyframe at the same 5 points, 32 x 18 grey
async function picturePrint(ffmpeg, p, dur) {
  var v = [];
  for (var i = 0; i < POINTS.length; i++) {
    var fr = await run(ffmpeg, ['-v', 'error', '-skip_frame', 'nokey', '-ss', (dur * POINTS[i]).toFixed(3), '-i', p, '-frames:v', '1', '-vf', 'scale=' + FW + ':' + FH + ':flags=area,format=gray', '-f', 'rawvideo', '-']);
    v.push(fr && fr.length >= FW * FH ? fr.slice(0, FW * FH).toString('base64') : '');
  }
  return v;
}
function frameDiff(x, y) {
  if (!x || !y) return 255;
  var A = Buffer.from(x, 'base64'), B = Buffer.from(y, 'base64'), n = Math.min(A.length, B.length), s = 0;
  if (!n) return 255;
  for (var i = 0; i < n; i++) s += Math.abs(A[i] - B[i]);
  return s / n;
}
function corr0(x, y) {
  var n = Math.min(x.length, y.length); if (n < 50) return 0;
  var mx = 0, my = 0, i; for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  var sxy = 0, sxx = 0, syy = 0;
  for (i = 0; i < n; i++) { var dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx < 1e-6 && syy < 1e-6) return 1;          // both silent
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
// best correlation with up to ±0.5 s of offset (container start times can differ by a few frames)
function corr(x, y) {
  var best = corr0(x, y);
  for (var lag = 1; lag <= 25; lag++) { best = Math.max(best, corr0(x.slice(lag), y), corr0(x, y.slice(lag))); }
  return best;
}
function soundScore(a1, a2) {         // 2nd lowest of the 5 window scores: one odd window (a cough, the file end) is forgiven
  var sc = POINTS.map(function (_, i) { return corr(a1[i] || [], a2[i] || []); }).sort(function (x, y) { return x - y; });
  return sc[1];
}
function sameContent(f1, f2) {
  var diffs = POINTS.map(function (_, i) { return frameDiff(f1.v[i], f2.v[i]); }).sort(function (x, y) { return x - y; });
  var worst = diffs[diffs.length - 2], audio = soundScore(f1.a, f2.a);
  return { same: worst < V_SAME && audio > A_SAME, frameDiff: Math.round(worst * 10) / 10, audioCorr: Math.round(audio * 100) / 100 };
}
// the file to keep from an identical pair: no " (n)" suffix first, then the older file, then by name
function keeperOf(a, b) {
  var sa = / \(\d+\)\.[^.]+$/.test(a.file), sb = / \(\d+\)\.[^.]+$/.test(b.file);
  if (sa !== sb) return sa ? b : a;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs <= b.mtimeMs ? a : b;
  return a.file <= b.file ? a : b;
}

/* clips: [{file, path, w, h, seconds}]  -> resolves { results: {file: {status, of, detail}}, checked, fresh }
   status: 'identical' (skip), 'similar' (keep + flag), absent = distinct. progress(text) is optional. */
async function check(clips, opts) {
  var cacheFile = opts.cacheFile, ffmpeg = opts.ffmpeg, progress = opts.progress || function () {};
  var cache = loadCache(cacheFile), dirty = false, info = {};
  clips.forEach(function (c) {
    var st = fs.statSync(c.path), id = idOf(st), e = cache[c.path];
    if (!e || e.id !== id) { e = cache[c.path] = { id: id }; dirty = true; }
    info[c.file] = { c: c, size: st.size, mtimeMs: st.mtimeMs, e: e };
  });
  var files = Object.keys(info), results = {};
  // 1. identical: same size -> sampled hash -> full hash
  var bySize = {};
  files.forEach(function (f) { (bySize[info[f].size] = bySize[info[f].size] || []).push(f); });
  for (var s in bySize) {
    var g = bySize[s]; if (g.length < 2) continue;
    for (var i = 0; i < g.length; i++) {
      var e = info[g[i]].e;
      if (!e.sample) { progress('Hashing ' + g[i]); e.sample = await sampleHash(info[g[i]].c.path, info[g[i]].size); dirty = true; }
    }
    for (var x = 0; x < g.length; x++) for (var y = x + 1; y < g.length; y++) {
      var A = info[g[x]], B = info[g[y]];
      if (A.e.sample !== B.e.sample || results[g[x]] || results[g[y]]) continue;
      for (var z = 0; z < 2; z++) { var Z = z ? B : A; if (!Z.e.full) { progress('Confirming ' + Z.c.file + ' (full hash)'); Z.e.full = await fullHash(Z.c.path); dirty = true; } }
      if (A.e.full !== B.e.full) continue;
      var keep = keeperOf({ file: g[x], mtimeMs: A.mtimeMs }, { file: g[y], mtimeMs: B.mtimeMs }), drop = keep.file === g[x] ? g[y] : g[x];
      results[drop] = { status: 'identical', of: keep.file, detail: 'byte-identical to ' + keep.file };
    }
  }
  // 2. same recording, different file: only for pairs with the same frame size and duration
  var cand = [];
  for (var p = 0; p < files.length; p++) for (var q = p + 1; q < files.length; q++) {
    var a = info[files[p]], b = info[files[q]];
    if (results[files[p]] || results[files[q]]) continue;
    if (Math.abs(a.c.w / a.c.h - b.c.w / b.c.h) > 0.02 || Math.abs(a.c.seconds - b.c.seconds) > DUR_TOL) continue;   // same shape (any size) and length
    cand.push([files[p], files[q]]);
  }
  if (cand.length && !ffmpeg) {
    cand.forEach(function (pr) { results[pr[1]] = results[pr[1]] || { status: 'similar', of: pr[0], detail: 'same length as ' + pr[0] + ' (ffmpeg missing, not compared)' }; });
  }
  for (var k = 0; k < cand.length && ffmpeg; k++) {
    var pr = cand[k], A2 = info[pr[0]], B2 = info[pr[1]];
    for (var w = 0; w < 2; w++) { var I = w ? B2 : A2; if (!I.e.snd) { progress('Listening: ' + I.c.file); I.e.snd = await soundPrint(ffmpeg, I.c.path, I.c.seconds); dirty = true; } }
    if (soundScore(A2.e.snd, B2.e.snd) <= A_SAME) continue;                                   // different sound = different take
    for (var w2 = 0; w2 < 2; w2++) { var J = w2 ? B2 : A2; if (!J.e.pic) { progress('Comparing pictures: ' + J.c.file); J.e.pic = await picturePrint(ffmpeg, J.c.path, J.c.seconds); dirty = true; } }
    var r = sameContent({ v: A2.e.pic, a: A2.e.snd }, { v: B2.e.pic, a: B2.e.snd });
    var later = / \(\d+\)\.[^.]+$/.test(pr[0]) ? pr[0] : pr[1], other = later === pr[0] ? pr[1] : pr[0];
    if (r.same) results[later] = { status: 'similar', of: other, detail: 'same picture and sound as ' + other + ' but not the same file — check before building (frame diff ' + r.frameDiff + ', audio ' + r.audioCorr + ')' };
  }
  if (dirty) {
    var live = {}; files.forEach(function (f) { live[info[f].c.path] = cache[info[f].c.path]; });
    Object.keys(cache).forEach(function (k) { if (!live[k] && fs.existsSync(k)) live[k] = cache[k]; });   // keep other clients' entries
    saveCache(cacheFile, live);
  }
  return { results: results, checked: files.length, pairs: cand.length, at: new Date().toISOString() };
}
// true when every clip's identity is in the cache (a build can reuse the stored answer)
function cacheFresh(clips, cacheFile) {
  var cache = loadCache(cacheFile);
  return clips.every(function (c) { try { var e = cache[c.path]; return e && e.id === idOf(fs.statSync(c.path)) && e.checked === 2; } catch (x) { return false; } });
}
function markChecked(clips, cacheFile, results) {
  var cache = loadCache(cacheFile);
  clips.forEach(function (c) { var e = cache[c.path]; if (e) { e.checked = 2; e.result = results[c.file] || null; } });
  saveCache(cacheFile, cache);
}
function cachedResults(clips, cacheFile) {
  var cache = loadCache(cacheFile), out = {};
  clips.forEach(function (c) { var e = cache[c.path]; if (e && e.result) out[c.file] = e.result; });
  return out;
}

module.exports = { check: check, cacheFresh: cacheFresh, markChecked: markChecked, cachedResults: cachedResults, sameContent: sameContent, corr: corr };
