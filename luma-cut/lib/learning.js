/* UAI Luma Cut — lightweight learning store (~/UAI Luma Cut/learning).
   store.json   : settings, approved rules (kept until Reset), rolling batches (one batch = one client project:
                  its confirmed review changes + grade references). Only the last N batches are kept (default 3).
   thumbs/      : 320 px JPEG per grade reference (counted in the size cap).
   claude_context.json : small derived file Claude reads in Claude mode (rules + recent examples).
   Writes are atomic (tmp + rename); old batches are pruned only after the new state is written.
   Nothing here trains a model: Standalone applies only the active bounded rules below; Claude reads the context file. */
'use strict';
var fs = require('fs'), path = require('path');

var DEFAULTS = { version: 1, retention: 3, maxBytes: 10 * 1024 * 1024, rules: {}, batches: [] };
// bounds per rule (absolute value of the learned offset); fields outside this table are recorded for Claude only
var BOUNDS = {
  'Best grade|Exposure': 0.5, 'Best grade|Contrast': 15, 'Best grade|Highlights': 15, 'Best grade|Shadows': 15, 'Best grade|Whites': 15,
  'Best grade|Blacks': 15, 'Best grade|Temperature': 10, 'Best grade|Tint': 10, 'Best grade|Saturation': 15,
  'Skin|Hue Shift': 6, 'Skin|Sat Shift': 6, 'Skin|Lum Shift': 8, 'Green screen|Hue Shift': 6, 'Green screen|Sat Shift': 8, 'Green screen|Lum Shift': 12,
  'Trim|IN': 0.5, 'Trim|OUT': 0.5
};
var LUM_KEY = { Exposure: 'Exposure', Contrast: 'Contrast', Highlights: 'Highlights', Shadows: 'Shadows', Whites: 'Whites', Blacks: 'Blacks', Temperature: 'Temperature', Tint: 'Tint', Saturation: 'Saturation' };

function Store(dir) {
  this.dir = dir; this.file = path.join(dir, 'store.json'); this.thumbs = path.join(dir, 'thumbs'); this.ctx = path.join(dir, 'claude_context.json');
}
Store.prototype.load = function () {
  var s; try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { s = null; }
  s = s || JSON.parse(JSON.stringify(DEFAULTS));
  if (!s.rules) s.rules = {}; if (!Array.isArray(s.batches)) s.batches = [];
  if (!s.retention) s.retention = DEFAULTS.retention; if (!s.maxBytes) s.maxBytes = DEFAULTS.maxBytes;
  return s;
};
Store.prototype.exists = function () { return fs.existsSync(this.file); };
Store.prototype.write = function (s) {
  fs.mkdirSync(this.dir, { recursive: true });
  var tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, this.file);
  this.writeContext(s);
};
function dirBytes(d) {
  var n = 0; try { fs.readdirSync(d).forEach(function (f) { var p = path.join(d, f), st = fs.statSync(p); n += st.isDirectory() ? dirBytes(p) : st.size; }); } catch (e) {}
  return n;
}
Store.prototype.usage = function () { return dirBytes(this.dir); };
Store.prototype.batch = function (s, key, meta) {
  var b = s.batches.filter(function (x) { return x.key === key; })[0];
  if (!b) { b = { key: key, client: meta.client, ac: !!meta.ac, project: meta.project || '', reviews: [], references: [] }; s.batches.push(b); }
  b.updatedAt = new Date().toISOString();
  return b;
};
// keep the newest `retention` batches, then shrink further until the folder is under maxBytes (never the current batch)
Store.prototype.prune = function (s, keepKey) {
  var self = this;
  s.batches.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  var dropped = s.batches.slice(s.retention);
  s.batches = s.batches.slice(0, s.retention);
  self.write(s);                                     // state first, files after: a failed write never loses the kept batches
  dropped.forEach(function (b) { self.removeThumbs(b); });
  while (self.usage() > s.maxBytes) {
    var old = s.batches.filter(function (b) { return b.key !== keepKey; }).pop();
    if (old) { s.batches.splice(s.batches.indexOf(old), 1); self.write(s); self.removeThumbs(old); continue; }
    var cur = s.batches[0]; if (!cur || !cur.references.length) break;
    var ref = cur.references.shift(); self.write(s); try { if (ref.thumb) fs.unlinkSync(ref.thumb); } catch (e) {}
  }
  return dropped.length;
};
Store.prototype.removeThumbs = function (b) {
  (b.references || []).forEach(function (r) { try { if (r.thumb) fs.unlinkSync(r.thumb); } catch (e) {} });
};

// a confirmed review: changes = [{clip, camera, items:[{area, field, from, to}]}]; updates the rules, then prunes
Store.prototype.addReview = function (meta, changes, note, reviewer) {
  var s = this.load(), b = this.batch(s, meta.key, meta);
  b.reviews.push({ date: new Date().toISOString(), reviewer: reviewer, note: note, project: meta.project || '', changes: changes });
  b.reviews = b.reviews.slice(-5);
  updateRules(s, meta.key, changes);
  var dropped = this.prune(s, meta.key);
  return { batches: s.batches.length, dropped: dropped, active: activeRules(s).length };
};
Store.prototype.addReference = function (meta, ref) {
  var s = this.load(), b = this.batch(s, meta.key, meta);
  b.references = b.references.filter(function (r) { return r.clip !== ref.clip; });
  b.references.push(ref);
  return this.prune(s, meta.key);
};
Store.prototype.setRetention = function (n) { var s = this.load(); s.retention = Math.max(1, Math.min(10, n | 0)); return this.prune(s, null); };
Store.prototype.reset = function () {
  var s = this.load(), backup = path.join(this.dir, '..', 'learning_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  try { fs.writeFileSync(backup, JSON.stringify(s)); } catch (e) {}
  var self = this; s.batches.forEach(function (b) { self.removeThumbs(b); });
  var fresh = JSON.parse(JSON.stringify(DEFAULTS)); fresh.retention = s.retention;
  this.write(fresh);
  return backup;
};

// ---- rules: running mean per area|field (and per camera), active only when repeated and consistent ----
function updateRules(s, batchKey, changes) {
  changes.forEach(function (c) {
    c.items.forEach(function (it) {
      var key = it.area + '|' + it.field, d = it.to - it.from;
      if (!isFinite(d) || !(key in BOUNDS)) return;
      [key, key + '|' + (c.camera || '?')].forEach(function (k) {
        var r = s.rules[k] || (s.rules[k] = { n: 0, sum: 0, pos: 0, neg: 0, batches: [] });
        r.n++; r.sum += d; if (d > 0) r.pos++; else if (d < 0) r.neg++;
        if (r.batches.indexOf(batchKey) < 0) r.batches.push(batchKey);
        r.updatedAt = new Date().toISOString();
      });
    });
  });
}
function activeRules(s) {
  var out = [];
  Object.keys(s.rules).forEach(function (k) {
    var r = s.rules[k], parts = k.split('|'), base = parts[0] + '|' + parts[1], bound = BOUNDS[base];
    if (!bound || r.n < 3 || r.batches.length < 2) return;
    var agree = Math.max(r.pos, r.neg) / Math.max(1, r.pos + r.neg);
    if (agree < 0.75) return;
    var mean = r.sum / r.n, v = Math.max(-bound, Math.min(bound, mean));
    if (Math.abs(v) < bound * 0.05) return;
    out.push({ area: parts[0], field: parts[1], camera: parts[2] || '*', offset: Math.round(v * 100) / 100, clips: r.n, batches: r.batches.length });
  });
  return out;
}
Store.prototype.activeRules = function () { return activeRules(this.load()); };
// One-time repair (1.7.0): before 1.7.0 every review was saved under the panel's chosen client folder, not the
// project that was open, so reviews from different clients shared one batch and no rule could reach 2 batches.
// moves: [{ at: 'YYYY-MM-DDTHH:MM' (UTC minute), key, client, ac }] — a review within 2 min of `at` goes to that batch.
// Then every rule is rebuilt from the stored reviews. Runs once per id; nothing is deleted.
Store.prototype.repair = function (id, moves) {
  if (!this.exists()) return 0;
  var s = this.load(); s.repairs = s.repairs || [];
  if (s.repairs.indexOf(id) >= 0) return 0;
  var self = this, moved = 0;
  s.batches.slice().forEach(function (b) {
    b.reviews = (b.reviews || []).filter(function (r) {
      var t = Date.parse(r.date), m = moves.filter(function (x) { return Math.abs(Date.parse(x.at + ':00Z') - t) <= 120000; })[0];
      if (!m || m.key === b.key) return true;
      var nb = self.batch(s, m.key, { client: m.client, ac: m.ac, project: r.project || '' });
      nb.reviews.push(r); nb.reviews.sort(function (x, y) { return String(x.date).localeCompare(String(y.date)); });
      nb.updatedAt = r.date > (nb.updatedAt || '') ? r.date : nb.updatedAt; moved++;
      return false;
    });
  });
  s.batches = s.batches.filter(function (b) { return b.reviews.length || b.references.length; });
  s.rules = {};
  s.batches.forEach(function (b) { b.reviews.forEach(function (r) { updateRules(s, b.key, r.changes || []); }); });
  s.repairs.push(id);
  this.write(s);
  return moved;
};
// Standalone: Lumetri offsets (all cameras) + pre/post roll adjustment, bounded
Store.prototype.standalone = function () {
  var grade = {}, trim = { pre: 0, post: 0 }, n = 0;
  activeRules(this.load()).forEach(function (r) {
    if (r.camera !== '*') return;
    if (r.area === 'Best grade' && LUM_KEY[r.field]) { grade[LUM_KEY[r.field]] = r.offset; n++; }
    if (r.area === 'Trim' && r.field === 'IN') { trim.pre = -r.offset; n++; }      // IN later = less pre-roll
    if (r.area === 'Trim' && r.field === 'OUT') { trim.post = r.offset; n++; }
  });
  return { grade: grade, trim: trim, count: n };
};
Store.prototype.writeContext = function (s) {
  var ctx = {
    about: 'UAI Luma Cut learning context. Rules are bounded mean offsets confirmed by a human in at least 2 batches; examples are the most recent confirmed reviews and grade references. Use them as guidance, not as fixed values.',
    rules: activeRules(s),
    batches: s.batches.map(function (b) {
      return { client: b.client, ac: b.ac, updatedAt: b.updatedAt,
        reviews: b.reviews.slice(-2).map(function (r) { return { date: r.date, note: r.note, changes: r.changes.slice(0, 20) }; }),
        references: b.references.slice(0, 12).map(function (r) { return { clip: r.clip, camera: r.camera, lumetri: r.lumetri, skin: r.skin, green: r.green, image: r.image, thumb: r.thumb }; }) };
    })
  };
  try { var tmp = this.ctx + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(ctx, null, 1)); fs.renameSync(tmp, this.ctx); } catch (e) {}
};
Store.prototype.lastReview = function () {
  var s = this.load(), best = null;
  s.batches.forEach(function (b) { (b.reviews || []).forEach(function (r) { if (!best || r.date > best.date) best = { date: r.date, client: b.client, changes: r.changes.length }; }); });
  return best;
};

// one-time import of the old files (grade_memory.jsonl, grade_samples.jsonl); originals stay untouched
Store.prototype.migrate = function (memoryFile, samplesFile) {
  if (this.exists()) return 0;
  var s = JSON.parse(JSON.stringify(DEFAULTS)), n = 0;
  var lines = function (f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
  var self = this;
  lines(memoryFile).forEach(function (e) {
    var b = self.batch(s, e.client || 'Client', { client: e.client, ac: e.ac, project: e.project });
    b.updatedAt = e.date; b.reviews.push({ date: e.date, reviewer: e.reviewer, note: e.note, changes: e.changes || [] });
    updateRules(s, b.key, e.changes || []); n++;
  });
  lines(samplesFile).forEach(function (e) {
    var b = self.batch(s, e.client || 'Client', { client: e.client, ac: e.ac });
    b.updatedAt = e.date; b.references.push({ clip: e.clip, camera: e.camera, lumetri: e.lumetri, skin: e.skin, green: e.green, image: e.image, thumb: '', date: e.date }); n++;
  });
  s.batches.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  s.batches = s.batches.slice(0, s.retention);
  this.write(s);
  return n;
};

module.exports = { Store: Store, BOUNDS: BOUNDS, activeRules: activeRules };
