/* UAI Luma Cut — builds a Premiere-importable FCP7 XML (xmeml v4) from a Luma plan.
   Port of the engine's build_xml.py + lumetri.py, with the Premiere 2027 rules that make the grade render:
   - the Lumetri "Blob" parameter is left out (the template already has none)
   - the Input LUT is a full .cube path, UTF-16LE + NUL, base64 (parameter 4)
   - vertical clips: Basic Motion rotation -90 at scale 100 (XML import ignores the file's rotation flag)
   Layout: bin "Sequences" holding one sequence per size and orientation (8K HZ, 8K VER, 4K HZ, 4K VER …).
   Each clip is cut head | body | tail; head and tail stay on the timeline disabled; IN/OUT markers on every body.
   Works in Node (tests) and in the CEP panel (Node enabled). No dependencies. */
'use strict';

var GRADE_KEYS = ['Temperature', 'Tint', 'Saturation', 'Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks'];
var HOUSE = { Exposure: 0, Contrast: 19, Highlights: 8, Shadows: -6, Saturation: 108, Tint: 2, Temperature: 0, Whites: 0, Blacks: 0 };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function pathurl(p) {
  return 'file://localhost' + String(p).split('/').map(function (seg) {
    return encodeURIComponent(seg).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
  }).join('/');
}
// Premiere writes whole numbers as "19." and others as "0.15"
function fmt(v) {
  v = Math.round(Number(v) * 1000) / 1000;
  if (Object.is(v, -0)) v = 0;
  var s = String(v);
  return (s.indexOf('.') < 0 && s.indexOf('e') < 0) ? s + '.' : s;
}
// 29.97 -> timebase 30 NTSC; 25 -> 25; 23.976 -> 24 NTSC; 59.94 -> 60 NTSC
function rateOf(fps) {
  fps = Number(fps) || 29.97;
  var base = Math.round(fps), ntsc = Math.abs(fps - base) > 0.005;
  return { base: base, ntsc: ntsc, fps: fps };
}
function rateXml(r) { return '<rate><timebase>' + r.base + '</timebase><ntsc>' + (r.ntsc ? 'TRUE' : 'FALSE') + '</ntsc></rate>'; }

function sizeKey(c) {
  var long = Math.max(c.w, c.h);
  var tier = long >= 7000 ? '8K' : long >= 3800 ? '4K' : long >= 2500 ? '2.7K' : 'HD';
  return { tier: tier, orient: c.w >= c.h ? 'HZ' : 'VER' };
}
function isVertical(rot) { rot = Number(rot) || 0; return Math.abs(rot) % 180 === 90; }

function lutParam(lutPath) {
  if (!lutPath) return '';
  return Buffer.from(String(lutPath) + '\u0000', 'utf16le').toString('base64');
}
function lumetriFilter(template, grade, lutPath) {
  var g = {}, k;
  for (k in HOUSE) g[k] = HOUSE[k];
  for (k in (grade || {})) if (GRADE_KEYS.indexOf(k) >= 0 && isFinite(Number(grade[k]))) g[k] = Number(grade[k]);
  var out = template.replace('{{NAME}}', 'S-Log Lumetri').replace('{{LUT}}', lutParam(lutPath));
  GRADE_KEYS.forEach(function (key) { out = out.split('{{' + key + '}}').join(fmt(g[key])); });
  if (/\{\{[A-Za-z]+\}\}/.test(out)) throw new Error('Lumetri template has an unfilled value');
  return out;
}
function motionFilter(c) {
  if (!isVertical(c.rot)) return '';
  return '<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory>' +
    '<effecttype>motion</effecttype><mediatype>video</mediatype>' +
    '<parameter authoringApp="PremierePro"><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>100</value></parameter>' +
    '<parameter authoringApp="PremierePro"><parameterid>rotation</parameterid><name>Rotation</name><valuemin>-8640</valuemin><valuemax>8640</valuemax><value>-90</value></parameter>' +
    '</effect></filter>';
}
function fileXml(c, first) {
  var fid = 'file-' + c.uid;
  if (!first) return '<file id="' + fid + '"/>';
  var r = rateXml(c.rate);
  return '<file id="' + fid + '"><name>' + esc(c.file) + '</name><pathurl>' + esc(pathurl(c.path)) + '</pathurl>' +
    r + '<duration>' + c.frames + '</duration>' +
    '<media><video><samplecharacteristics>' + r + '<width>' + c.raw_w + '</width><height>' + c.raw_h + '</height>' +
    '<pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>' +
    '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>' +
    '<channelcount>2</channelcount></audio></media></file>';
}

var EDGE = 2;   // frames of clean edge around IN/OUT (user rule 26 Nov: no black frame at export start/end)

function Seq(sid, name, w, h, rate) {
  this.sid = sid; this.name = name; this.w = w; this.h = h; this.rate = rate;
  this.v = []; this.a = []; this.markers = []; this.t = 0; this.n = 0;
}
Seq.prototype.addPiece = function (c, srcIn, srcOut, enabled, filters, seen) {
  if (srcOut <= srcIn) return null;
  this.n++;
  var dur = srcOut - srcIn, vid = this.sid + '-v' + this.n, aid = this.sid + '-a' + this.n;
  var first = !seen[c.uid]; seen[c.uid] = true;
  var link = '<link><linkclipref>' + vid + '</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>' + this.n + '</clipindex></link>' +
             '<link><linkclipref>' + aid + '</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>' + this.n + '</clipindex><groupindex>1</groupindex></link>';
  var common = '<name>' + esc(c.file) + '</name><enabled>' + (enabled ? 'TRUE' : 'FALSE') + '</enabled>' +
    '<duration>' + c.frames + '</duration>' + rateXml(c.rate) + '<start>' + this.t + '</start><end>' + (this.t + dur) + '</end>' +
    '<in>' + srcIn + '</in><out>' + srcOut + '</out>';
  this.v.push('<clipitem id="' + vid + '">' + common + fileXml(c, first) + motionFilter(c) + (enabled ? filters : '') + link + '</clipitem>');
  this.a.push('<clipitem id="' + aid + '">' + common + '<file id="file-' + c.uid + '"/>' +
    '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' + link + '</clipitem>');
  var start = this.t; this.t += dur; return start;
};
Seq.prototype.marker = function (frame, name, comment, color) {
  this.markers.push('<marker><name>' + esc(name) + '</name><comment>' + esc(comment) + '</comment><in>' + frame + '</in><out>-1</out>' +
    '<pproColor>' + (color || 'Green') + '</pproColor></marker>');
};
Seq.prototype.xml = function () {
  var r = rateXml(this.rate);
  return '<sequence id="' + this.sid + '"><name>' + esc(this.name) + '</name><duration>' + this.t + '</duration>' + r +
    '<media><video><format><samplecharacteristics>' + r + '<width>' + this.w + '</width><height>' + this.h + '</height>' +
    '<pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>' +
    '<track>' + this.v.join('') + '</track></video>' +
    '<audio><numOutputChannels>2</numOutputChannels>' +
    '<outputs><group><index>1</index><numchannels>2</numchannels><downmix>0</downmix><channel><index>1</index></channel><channel><index>2</index></channel></group></outputs>' +
    '<track>' + this.a.join('') + '<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>1</outputchannelindex></track></audio></media>' +
    this.markers.join('') + '</sequence>';
};

/* plan: { client, clips:[{file, path, w, h, rot, fps, frames, in, out, flag, grade}] }
   w/h are the picture as seen (vertical = taller than wide). in/out are frame numbers, out inclusive.
   opts: { template (Lumetri filter XML with {{tokens}}), lutPath } */
function build(plan, opts) {
  if (!plan || !Array.isArray(plan.clips) || !plan.clips.length) throw new Error('The plan has no clips');
  if (!opts || !opts.template) throw new Error('Lumetri template missing');
  var client = String(plan.client || 'CLIENT').replace(/[^A-Za-z0-9_-]+/g, '_');
  var clips = plan.clips.map(function (c, i) {
    var vert = isVertical(c.rot);
    var w = Number(c.w), h = Number(c.h);
    var frames = Math.max(1, Math.floor(Number(c.frames)));
    var fi = Math.max(0, Math.min(frames - 1, Math.round(Number(c['in']) || 0)));
    var fo = Math.max(fi, Math.min(frames - 1, Math.round(isFinite(Number(c.out)) ? Number(c.out) : frames - 1)));
    return {
      uid: i + 1, file: c.file, path: c.path, w: w, h: h, rot: Number(c.rot) || 0,
      raw_w: vert ? h : w, raw_h: vert ? w : h, frames: frames, rate: rateOf(c.fps),
      inF: fi, outF: fo, flag: c.flag ? String(c.flag) : '', grade: c.grade || {}
    };
  });
  var groups = {}, order = [];
  clips.forEach(function (c) {
    var k = sizeKey(c), key = k.tier + '_' + k.orient;
    if (!groups[key]) { groups[key] = { tier: k.tier, orient: k.orient, clips: [] }; order.push(key); }
    groups[key].clips.push(c);
  });
  order.sort();
  var seen = {}, seqs = [], summary = [];
  order.forEach(function (key) {
    var g = groups[key], cs = g.clips.slice().sort(function (a, b) { return a.file < b.file ? -1 : a.file > b.file ? 1 : 0; });
    var s = new Seq('seq-' + key, client + '_' + key, cs[0].w, cs[0].h, cs[0].rate);
    cs.forEach(function (c) {
      // clean edge: the enabled body is cut EDGE frames wider than IN/OUT on each side, the markers sit on the IN/OUT
      // frames themselves (EDGE frames inside the enabled body) and Smart Export exports marker to marker, so no
      // disabled (black) frame can reach the start or end of an export
      var e0 = Math.min(EDGE, c.inF), e1 = Math.min(EDGE, c.frames - 1 - c.outF);
      var fi = c.inF - e0, fo = c.outF + 1 + e1;   // out is exclusive inside the XML
      s.addPiece(c, 0, fi, false, '', seen);
      var b0 = s.addPiece(c, fi, fo, true, lumetriFilter(opts.template, c.grade, opts.lutPath), seen);
      var rv = /REVIEW|check/i.test(c.flag);
      s.marker(b0 + e0, 'IN ' + c.file, rv ? 'REVIEW: ' + c.flag : 'IN: mouth closed, no teeth, eyes open, hands at rest, still', rv ? 'Red' : 'Green');
      s.marker(b0 + (fo - fi) - 1 - e1, 'OUT ' + c.file, rv ? 'REVIEW: ' + c.flag : 'OUT: mouth closed, no teeth, eyes open, hands at rest, still', rv ? 'Red' : 'Green');
      s.addPiece(c, fo, c.frames, false, '', seen);
    });
    seqs.push(s);
    summary.push({ name: s.name, w: s.w, h: s.h, clips: cs.length });
  });
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><project><name>' + esc(client) + '_GRADED</name>' +
    '<children><bin><name>Sequences</name><children>' + seqs.map(function (s) { return s.xml(); }).join('') + '</children></bin></children></project></xmeml>\n';
  return { xml: xml, sequences: summary, review: clips.filter(function (c) { return c.flag; }).map(function (c) { return c.file; }) };
}

module.exports = { build: build, fmt: fmt, pathurl: pathurl, lumetriFilter: lumetriFilter, sizeKey: sizeKey, rateOf: rateOf, HOUSE: HOUSE, GRADE_KEYS: GRADE_KEYS };
