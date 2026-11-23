/* UAI Luma Cut — Color Mode "Color Shift" read/write inside a saved Premiere 2027 .prproj (gzip XML).
   Premiere's scripting cannot see or change Color Mode, so the panel saves + closes the project, edits the file
   with this module, and reopens it.

   Color Shift filter (matchName "AE.ADBE Color Shift"), params: 0 = swatch list, 3 = Sat curve, 8 = Hue curve, 13 = Lum curve.
   Curve blob: 8 zero bytes, int64 param id, int64 point count, then per point 7 float64
   (x = colour position, y = shift (dial / 100), then 5 shape values) + 1 flag byte, then 8 trailing zero bytes.
   Skin points sit near x 0.02, the green-screen point near x 0.37. */
'use strict';
var fs = require('fs'), zlib = require('zlib');

var OBJ_RE = /\n\t<(\w+) (Object(?:U)?ID)="([^"]+)"([^>]*)>([\s\S]*?)\n\t<\/\1>/g;
var REF_RE = /(Object(?:U)?Ref)="([^"]+)"/g;
var CURVES = { sat: 3, hue: 8, lum: 13 };
var PIDS = { sat: 4, hue: 9, lum: 14 };
var SKIN_MAX_X = 0.2, GREEN_MIN_X = 0.25, GREEN_MAX_X = 0.55;

function load(file) {
  var s = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  var objs = {}, m;
  OBJ_RE.lastIndex = 0;
  while ((m = OBJ_RE.exec(s))) objs[m[3]] = { tag: m[1], kind: m[2], attrs: m[4], body: m[5], text: m[0] };
  return { file: file, s: s, objs: objs };
}
function refs(body) { var out = [], m; REF_RE.lastIndex = 0; while ((m = REF_RE.exec(body))) out.push(m[2]); return out; }
function subtree(objs, root) {
  var seen = {}, order = [], st = [root];
  while (st.length) { var o = st.pop(); if (seen[o] || !objs[o]) continue; seen[o] = 1; order.push(o); st = st.concat(refs(objs[o].body)); }
  return order;
}
function components(objs, chain) {
  var out = [], re = /<Component Index="(\d+)" ObjectRef="([^"]+)"\/>/g, m;
  while ((m = re.exec(objs[chain].body))) out.push(m[2]);
  return out;
}
function chainOf(objs, ti) {
  var r = refs(objs[ti].body);
  for (var i = 0; i < r.length; i++) if (objs[r[i]] && objs[r[i]].tag === 'VideoComponentChain' && objs[r[i]].body.indexOf('<ComponentChain') >= 0) return r[i];
  return null;
}
function clipName(objs, ti) {
  var m = /<SubClip ObjectRef="([^"]+)"/.exec(objs[ti].body); if (!m || !objs[m[1]]) return null;
  var n = /<Name>([^<]*)/.exec(objs[m[1]].body); return n ? n[1] : null;
}
function colorShiftIn(objs, root) {
  var t = subtree(objs, root);
  for (var i = 0; i < t.length; i++) if (objs[t[i]].tag === 'VideoFilterComponent' && objs[t[i]].body.indexOf('AE.ADBE Color Shift') >= 0) return t[i];
  return null;
}
function isLumetri(objs, c) { return objs[c] && objs[c].body.indexOf('AE.ADBE Lumetri') >= 0; }
function paramMap(body) { var out = {}, re = /<Param Index="(\d+)" ObjectRef="([^"]+)"\/>/g, m; while ((m = re.exec(body))) out[+m[1]] = m[2]; return out; }

// body clips = the enabled piece with the S-Log Lumetri; name -> [{ti, chain, root, filter}]
function bodyClips(ctx) {
  var objs = ctx.objs, out = {};
  Object.keys(objs).forEach(function (id) {
    if (objs[id].tag !== 'VideoClipTrackItem') return;
    var ch = chainOf(objs, id); if (!ch) return;
    var comps = components(objs, ch);
    if (!comps.some(function (c) { return isLumetri(objs, c); })) return;
    var root = null, filter = null;
    comps.forEach(function (c) { if (!root && objs[c] && objs[c].tag === 'CompoundComponent') { var f = colorShiftIn(objs, c); if (f) { root = c; filter = f; } } });
    var name = clipName(objs, id);
    (out[name] = out[name] || []).push({ ti: id, chain: ch, root: root, filter: filter });
  });
  return out;
}

function blobOf(body) {
  var m = /<StartKeyframeValue Encoding="base64"[^>]*>([^<]*)</.exec(body);
  return m ? Buffer.from(m[1].trim(), 'base64') : Buffer.alloc(0);
}
function decodeCurve(b) {
  if (!b || b.length < 24) return { points: [] };
  var n = Number(b.readBigInt64LE(16)), pts = [], off = 24;
  for (var k = 0; k < n && off + 57 <= b.length; k++) {
    var d = []; for (var j = 0; j < 7; j++) d.push(b.readDoubleLE(off + j * 8));
    pts.push({ x: d[0], y: d[1], shape: d.slice(2), flag: b[off + 56] }); off += 57;
  }
  return { points: pts };
}
function encodeCurve(pid, pts) {
  var b = Buffer.alloc(24 + pts.length * 57 + 8);
  b.writeBigInt64LE(BigInt(pid), 8); b.writeBigInt64LE(BigInt(pts.length), 16);
  pts.forEach(function (p, k) {
    var off = 24 + k * 57, d = [p.x, p.y].concat(p.shape);
    for (var j = 0; j < 7; j++) b.writeDoubleLE(d[j], off + j * 8);
    b[off + 56] = p.flag || 0;
  });
  return b;
}
function setBlob(text, buf) {
  var hex = ('00000000' + (buf.length + 12).toString(16)).slice(-8);
  var b64 = buf.toString('base64');
  var m = /<StartKeyframeValue Encoding="base64"( BinaryHash="([^"]*)")?\s*(\/>|>[^<]*<\/StartKeyframeValue>)/.exec(text);
  if (!m) throw new Error('Color Shift curve has no value field');
  var hash = m[2] ? m[2].slice(0, -8) + hex : '';
  var repl = '<StartKeyframeValue Encoding="base64"' + (hash ? ' BinaryHash="' + hash + '"' : '') + '>' + b64 + '\n\t\t</StartKeyframeValue>';
  return text.slice(0, m.index) + repl + text.slice(m.index + m[0].length);
}
function pick(pts, which) {
  for (var i = 0; i < pts.length; i++) {
    var x = pts[i].x;
    if (which === 'skin' && x < SKIN_MAX_X) return i;
    if (which === 'green' && x >= GREEN_MIN_X && x <= GREEN_MAX_X) return i;
  }
  return -1;
}
function round2(v) { return Math.round(v * 100) / 100; }

// values in dial units: { skin:{hue,sat,lum}, green:{hue,sat,lum}, hasColorMode }
function readClip(ctx, entry) {
  var out = { hasColorMode: !!entry.filter, skin: { hue: 0, sat: 0, lum: 0 }, green: { hue: 0, sat: 0, lum: 0 } };
  if (!entry.filter) return out;
  var ps = paramMap(ctx.objs[entry.filter].body);
  Object.keys(CURVES).forEach(function (k) {
    var pts = decodeCurve(blobOf(ctx.objs[ps[CURVES[k]]].body)).points;
    var si = pick(pts, 'skin'), gi = pick(pts, 'green');
    if (si >= 0) out.skin[k] = round2(pts[si].y * 100);
    if (gi >= 0) out.green[k] = round2(pts[gi].y * 100);
  });
  return out;
}
function readAll(ctx) {
  var clips = bodyClips(ctx), out = {};
  Object.keys(clips).forEach(function (n) { out[n] = readClip(ctx, clips[n][0]); });
  return out;
}

// template: { root, colorShift, objects:[{id,tag,kind,attrs,body}] } — a Color Mode with skin + green swatches
function defaultShapes(tpl) {
  var byId = {}; tpl.objects.forEach(function (o) { byId[o.id] = o; });
  var ps = paramMap(byId[tpl.colorShift].body), skin = null, green = null;
  Object.keys(CURVES).forEach(function (k) {
    decodeCurve(blobOf(byId[ps[CURVES[k]]].body)).points.forEach(function (p) {
      if (p.x < SKIN_MAX_X && !skin) skin = { x: p.x, shape: p.shape, flag: p.flag };
      if (p.x >= GREEN_MIN_X && p.x <= GREEN_MAX_X && !green) green = { x: p.x, shape: p.shape, flag: p.flag };
    });
  });
  return { skin: skin, green: green };
}

/* edits: { "<clip name>": { skin:{hue,sat,lum}, green:{hue,sat,lum} } } — absolute dial values; a missing key leaves it.
   Returns { text, report }. */
function applyEdits(ctx, edits, tpl) {
  var objs = ctx.objs, clips = bodyClips(ctx), s = ctx.s, report = [];
  var shapes = defaultShapes(tpl);
  var maxId = 0; Object.keys(objs).forEach(function (k) { if (/^\d+$/.test(k)) maxId = Math.max(maxId, +k); });
  var appended = [], replaced = {}, added = {};   // replaced: id -> new text; added: id -> new object
  function text(id) { return replaced[id] !== undefined ? replaced[id] : objs[id].text; }

  Object.keys(edits).forEach(function (name) {
    (clips[name] || []).forEach(function (entry) {
      var filterId = entry.filter, paramTexts = {};
      var tplMap = null;
      if (!filterId) {                         // add a Color Mode adjustment from the template, first in the effect list
        tplMap = {}; tpl.objects.forEach(function (o) { tplMap[o.id] = String(++maxId); });
        var newObjs = {};
        tpl.objects.forEach(function (o) {
          var body = o.body.replace(REF_RE, function (m0, a, r) { return a + '="' + (tplMap[r] || r) + '"'; });
          newObjs[tplMap[o.id]] = { tag: o.tag, kind: o.kind, attrs: o.attrs, body: body };
        });
        var comps = components(objs, entry.chain);
        var used = []; comps.forEach(function (c) { var mm = /<Component Version="\d+">\s*<Unique>[^<]*<\/Unique>\s*<ID>(\d+)<\/ID>/.exec(objs[c] ? objs[c].body : ''); if (mm) used.push(+mm[1]); });
        var rootNew = newObjs[tplMap[tpl.root]];
        rootNew.body = rootNew.body.replace(/(<Component Version="\d+">\s*<Unique>[^<]*<\/Unique>\s*<ID>)\d+(<\/ID>)/, function (m0, a, b) { return a + (Math.max.apply(null, used.concat([0])) + 1) + b; });
        var chainText = text(entry.chain), chainBody = objs[entry.chain].body;
        var block = [tplMap[tpl.root]].concat(comps).map(function (c, i) { return '\n\t\t\t\t<Component Index="' + i + '" ObjectRef="' + c + '"/>'; }).join('');
        var nb = chainBody.replace(/(<Components Version="1">)([\s\S]*?)(\n\t\t\t<\/Components>)/, function (m0, a, b, c) { return a + block + c; });
        replaced[entry.chain] = chainText.replace(chainBody, nb);
        filterId = tplMap[tpl.colorShift];
        Object.keys(newObjs).forEach(function (id) { appended.push(id); paramTexts[id] = newObjs[id]; added[id] = newObjs[id]; });
        // a fresh adjustment starts neutral: keep the template's skin/green points but at 0
        var tps = paramMap(newObjs[filterId].body);
        Object.keys(CURVES).forEach(function (k) {
          var o = newObjs[tps[CURVES[k]]], pts = decodeCurve(blobOf(o.body)).points;
          pts.forEach(function (p) { p.y = 0; });
          o.body = setBlob(o.body, encodeCurve(PIDS[k], pts));
        });
        report.push(name + ': Color Mode added');
      }
      var getBody = function (id) { return paramTexts[id] ? paramTexts[id].body : objs[id].body; };
      var ps = paramMap(getBody(filterId));
      var e = edits[name], changed = [];
      Object.keys(CURVES).forEach(function (k) {
        var pid = ps[CURVES[k]], body = getBody(pid), pts = decodeCurve(blobOf(body)).points, dirty = false;
        ['skin', 'green'].forEach(function (which) {
          if (!e[which] || e[which][k] === undefined || e[which][k] === null) return;
          var v = Number(e[which][k]); if (!isFinite(v)) return;
          var i = pick(pts, which), did = false;
          if (i >= 0) { if (round2(pts[i].y * 100) !== round2(v)) { pts[i].y = v / 100; did = true; } }
          else if (v !== 0 && shapes[which]) { pts.push({ x: shapes[which].x, y: v / 100, shape: shapes[which].shape.slice(), flag: shapes[which].flag }); did = true; }
          if (did) { dirty = true; changed.push(which + ' ' + k + ' ' + (v > 0 ? '+' : '') + v); }
        });
        if (!dirty) return;
        pts.sort(function (a, b) { return a.x - b.x; });
        var buf = encodeCurve(PIDS[k], pts);
        if (paramTexts[pid]) paramTexts[pid].body = setBlob(paramTexts[pid].body, buf);
        else replaced[pid] = setBlob(text(pid), buf);
      });
      if (changed.length) report.push(name + ': ' + changed.join(', '));
    });
    if (!clips[name]) report.push(name + ': not a graded clip in this project, skipped');
  });

  Object.keys(replaced).forEach(function (id) {
    if (s.split(objs[id].text).length !== 2) throw new Error('project object ' + id + ' is not unique');
    s = s.replace(objs[id].text, function () { return replaced[id]; });
  });
  if (appended.length) {
    var tail = s.lastIndexOf('\n</PremiereData>');
    if (tail < 0) throw new Error('unexpected project format');
    var add = appended.map(function (id) { var o = added[id]; return '\n\t<' + o.tag + ' ' + o.kind + '="' + id + '"' + o.attrs + '>' + o.body + '\n\t</' + o.tag + '>'; }).join('');
    s = s.slice(0, tail) + add + s.slice(tail);
  }
  return { text: s, report: report };
}
function applyAndSave(file, edits, tpl) {
  var ctx = load(file), res = applyEdits(ctx, edits, tpl);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(res.text, 'utf8')));
  return res.report;
}

module.exports = { load: load, bodyClips: bodyClips, readClip: readClip, readAll: readAll, applyEdits: applyEdits, applyAndSave: applyAndSave,
  decodeCurve: decodeCurve, encodeCurve: encodeCurve, blobOf: blobOf };
