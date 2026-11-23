/* UAI Luma Cut — reads size, rotation, frame rate and length from an MP4/MOV header. No ffprobe needed.
   Only the 'moov' box is read (a few MB at most), wherever it sits in the file. */
'use strict';
var fs = require('fs');

function readAt(fd, pos, len) {
  var b = Buffer.alloc(len), got = fs.readSync(fd, b, 0, len, pos);
  return got === len ? b : b.slice(0, got);
}
function boxHeader(fd, pos, fileSize) {
  var h = readAt(fd, pos, 16);
  if (h.length < 8) return null;
  var size = h.readUInt32BE(0), type = h.toString('latin1', 4, 8), hdr = 8;
  if (size === 1) { size = Number(h.readBigUInt64BE(8)); hdr = 16; }
  else if (size === 0) size = fileSize - pos;
  if (size < hdr) return null;
  return { type: type, size: size, hdr: hdr, pos: pos };
}
function children(buf, start, end) {
  var out = [], p = start;
  while (p + 8 <= end) {
    var size = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type: type, start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
function find(buf, box, type) { var c = children(buf, box.start, box.end); for (var i = 0; i < c.length; i++) if (c[i].type === type) return c[i]; return null; }
function fixed1616(buf, p) { return buf.readInt32BE(p) / 65536; }

function parseTrak(buf, trak) {
  var t = {};
  var tkhd = find(buf, trak, 'tkhd');
  if (tkhd) {
    var v = buf[tkhd.start], p = tkhd.start + 4 + (v === 1 ? 32 : 20) + 8 + 2 + 2 + 2 + 2;   // to matrix
    var a = fixed1616(buf, p), b = fixed1616(buf, p + 4);
    t.rot = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    t.tkW = fixed1616(buf, p + 36); t.tkH = fixed1616(buf, p + 40);
  }
  var mdia = find(buf, trak, 'mdia'); if (!mdia) return t;
  var hdlr = find(buf, mdia, 'hdlr'); if (hdlr) t.handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
  var mdhd = find(buf, mdia, 'mdhd');
  if (mdhd) {
    var mv = buf[mdhd.start];
    if (mv === 1) { t.timescale = buf.readUInt32BE(mdhd.start + 20); t.duration = Number(buf.readBigUInt64BE(mdhd.start + 24)); }
    else { t.timescale = buf.readUInt32BE(mdhd.start + 12); t.duration = buf.readUInt32BE(mdhd.start + 16); }
  }
  var minf = find(buf, mdia, 'minf'), stbl = minf && find(buf, minf, 'stbl');
  if (!stbl) return t;
  var stsd = find(buf, stbl, 'stsd');
  if (stsd && t.handler === 'vide') {
    var e = stsd.start + 8;                               // first sample entry
    t.codec = buf.toString('latin1', e + 4, e + 8);
    t.codedW = buf.readUInt16BE(e + 8 + 24); t.codedH = buf.readUInt16BE(e + 8 + 26);
  }
  var stts = find(buf, stbl, 'stts');
  if (stts) {
    var n = buf.readUInt32BE(stts.start + 4), count = 0, best = 0, bestDelta = 0;
    for (var i = 0; i < n; i++) {
      var c = buf.readUInt32BE(stts.start + 8 + i * 8), d = buf.readUInt32BE(stts.start + 12 + i * 8);
      count += c; if (c > best) { best = c; bestDelta = d; }
    }
    t.samples = count; t.delta = bestDelta;
  }
  return t;
}

function probe(file) {
  var fd = fs.openSync(file, 'r');
  try {
    var size = fs.fstatSync(fd).size, pos = 0, moov = null, guard = 0;
    while (pos < size && guard++ < 10000) {
      var h = boxHeader(fd, pos, size); if (!h) break;
      if (h.type === 'moov') { moov = h; break; }
      pos += h.size;
    }
    if (!moov) throw new Error('not an MP4/MOV file (no moov box)');
    if (moov.size > 256 * 1024 * 1024) throw new Error('moov box too large');
    var buf = readAt(fd, moov.pos, moov.size), root = { start: moov.hdr, end: buf.length };
    var traks = children(buf, root.start, root.end).filter(function (b) { return b.type === 'trak'; }).map(function (b) { return parseTrak(buf, b); });
    var v = traks.filter(function (t) { return t.handler === 'vide' && (t.codedW || t.tkW); })[0];
    if (!v) throw new Error('no video track');
    var hasAudio = traks.some(function (t) { return t.handler === 'soun'; });
    var codedW = v.codedW || Math.round(v.tkW), codedH = v.codedH || Math.round(v.tkH);
    var vertical = Math.abs(v.rot || 0) % 180 === 90;
    var fps = v.delta ? v.timescale / v.delta : (v.samples && v.duration ? v.samples * v.timescale / v.duration : 29.97);
    fps = Math.round(fps * 1000) / 1000;
    return {
      w: vertical ? codedH : codedW, h: vertical ? codedW : codedH, raw_w: codedW, raw_h: codedH,
      rot: v.rot || 0, fps: fps, frames: v.samples || Math.floor(v.duration / v.timescale * fps),
      seconds: v.duration / v.timescale, codec: v.codec || '', audio: hasAudio
    };
  } finally { fs.closeSync(fd); }
}

module.exports = { probe: probe };
