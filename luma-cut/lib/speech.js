/* UAI Luma Cut — Standalone trim: first and last word from the audio (same rule as the engine's speech_bounds).
   Needs ffmpeg on the Mac (Homebrew). Without ffmpeg the panel keeps the whole clip and flags it for review. */
'use strict';
var fs = require('fs'), cp = require('child_process');

var PRE = 0.80, POST = 0.60;     // editors leave ~0.8 s before the first word and ~0.6 s after the last (40 past projects)
var CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

function findFfmpeg() {
  for (var i = 0; i < CANDIDATES.length; i++) { try { if (fs.existsSync(CANDIDATES[i])) return CANDIDATES[i]; } catch (e) {} }
  return null;
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  var i = (sorted.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// 20 ms RMS in dB -> speech start/end (seconds), or null when nothing sounds like speech
function boundsFromDb(db) {
  if (!db.length) return null;
  var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
  var floor = percentile(sorted, 10), talk = percentile(sorted, 90), thr = Math.max(floor + 12, talk - 25, -50);
  var k = Math.round(0.5 / 0.02), need = Math.floor(k * 0.7), run = 0, first = -1, last = -1;
  var sp = new Uint8Array(db.length);
  for (var i = 0; i < db.length; i++) sp[i] = db[i] > thr ? 1 : 0;
  for (var j = 0; j < db.length; j++) {
    run += sp[j]; if (j >= k) run -= sp[j - k];
    if (j >= k - 1 && run >= need) { var s = j - k + 1; if (first < 0) first = s; last = s; }
  }
  if (first < 0) return null;
  // a / b: the real first / last voiced 20 ms frame, used to look for the next / previous sound.
  // start / end keep the window rule the 0.8 s / 0.6 s rolls were measured against.
  var a = first, b = Math.min(db.length - 1, last + k - 1);
  while (a < b && !sp[a]) a++;
  while (b > a && !sp[b]) b--;
  // next sound after the speech (breath, lip smack, "mm", off-camera noise) and the last one before it:
  // the pre/post roll must stop short of them so the cut lands on silence and a still mouth
  var GAP = 3, nextOn = -1, prevOff = -1, r = 0;
  for (var x = b + 1; x < db.length; x++) { r = sp[x] ? r + 1 : 0; if (r >= GAP) { nextOn = x - GAP + 1; break; } }
  r = 0;
  for (var y = a - 1; y >= 0; y--) { r = sp[y] ? r + 1 : 0; if (r >= GAP) { prevOff = y + GAP - 1; break; } }
  return { start: first * 0.02, end: (last + k) * 0.02, nextSound: nextOn >= 0 ? nextOn * 0.02 : null, prevSound: prevOff >= 0 ? (prevOff + 1) * 0.02 : null, floorDb: floor, thrDb: thr };
}
// callback(err, {start, end} | null)
function speechBounds(ffmpeg, file, cb) {
  var proc = cp.spawn(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  var HOP = 320, db = [], sum = 0, n = 0, carry = null, errText = '';
  proc.stdout.on('data', function (chunk) {
    if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
    var even = chunk.length - (chunk.length % 2);
    for (var i = 0; i < even; i += 2) {
      var v = chunk.readInt16LE(i) / 32768; sum += v * v; n++;
      if (n === HOP) { db.push(20 * Math.log10(Math.sqrt(sum / HOP) + 1e-9)); sum = 0; n = 0; }
    }
    if (even < chunk.length) carry = chunk.slice(even);
  });
  proc.stderr.on('data', function (d) { errText += d; });
  proc.on('error', function (e) { cb(e); });
  proc.on('close', function (code) {
    if (code !== 0 && !db.length) return cb(new Error(errText.trim().split('\n').pop() || 'ffmpeg failed'));
    cb(null, boundsFromDb(db));
  });
}
// frames in/out (out inclusive) for a clip, from speech bounds
function trimFrames(bounds, fps, frames) {
  if (!bounds) return { inF: 0, outF: frames - 1, flag: 'no speech found - set IN/OUT by hand' };
  var inT = bounds.start - PRE, outT = bounds.end + POST;
  // never roll into another sound: stop 0.1 s before it (keeping at least 0.1 s of air after / before the words)
  if (bounds.nextSound !== null && bounds.nextSound !== undefined) outT = Math.min(outT, Math.max(bounds.end + 0.1, bounds.nextSound - 0.1));
  if (bounds.prevSound !== null && bounds.prevSound !== undefined) inT = Math.max(inT, Math.min(bounds.start - 0.1, bounds.prevSound + 0.1));
  var inF = Math.max(0, Math.round(inT * fps));
  var outF = Math.min(frames - 1, Math.round(outT * fps));
  if (outF <= inF) return { inF: 0, outF: frames - 1, flag: 'speech too short - set IN/OUT by hand' };
  return { inF: inF, outF: outF, flag: '' };
}

module.exports = { findFfmpeg: findFfmpeg, speechBounds: speechBounds, boundsFromDb: boundsFromDb, trimFrames: trimFrames, PRE: PRE, POST: POST };
