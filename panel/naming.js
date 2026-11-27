/* UAI Smart Export — file names + versions (1.10.0)
   Template tokens: {Project} {Sequence} {Clip} {Ratio} {Date} v{NN} (also written {vNN})
   - {Project}/{Sequence} are compacted to CamelCase ("Flow Hook" -> "FlowHook", "part 22" -> "Part22").
   - {Clip} is the clip name as it is (colour-grading export: "CAM1-3932"), "Clip01" for Clips by cuts,
     the marker name for Markers.
   - Empty tokens vanish and the separators around them collapse ("FlowHook__9x16" -> "FlowHook_9x16").
   - {vNN}: the next free version in the folder, never an existing file (house rule BRAND_Topic_Ratio_vNN). */
(function (root) {
  var RATIOS = [[9, 16], [16, 9], [4, 5], [5, 4], [1, 1], [4, 3], [3, 4], [2, 3], [3, 2], [21, 9], [9, 21]];

  function ratio(w, h) {
    w = Number(w); h = Number(h);
    if (!(w > 0 && h > 0)) return '';
    var r = w / h, best = null, err = 1;
    RATIOS.forEach(function (p) { var e = Math.abs(p[0] / p[1] - r) / r; if (e < err) { err = e; best = p; } });
    return best && err < 0.025 ? best[0] + 'x' + best[1] : w + 'x' + h;
  }
  function camel(s) {
    return String(s || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').split(/[^A-Za-z0-9#]+/).filter(Boolean)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
  }
  function clean(s) { return String(s).replace(/[\/:*?"<>|\\]/g, '_').trim(); }
  function date(d) { d = d || new Date(); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); }

  // -> { prefix, suffix, versioned }  (the file stem is prefix + "v" + NN + suffix when versioned, else prefix)
  function parts(tpl, t) {
    var map = { Project: camel(t.project), Sequence: camel(t.sequence), Clip: clean(String(t.clip || '').replace(/\.[A-Za-z0-9]{2,4}$/, '')), Ratio: t.ratio || '', Date: t.date || date() };
    var s = String(tpl || '{Clip}');
    var versioned = /\{v?NN\}/i.test(s);
    s = s.replace(/\{(Project|Sequence|Clip|Ratio|Date)\}/g, function (m, k) { return map[k]; });
    s = s.replace(/v?\{v?NN\}/i, '\u0001').replace(/v?\{v?NN\}/ig, '');
    s = clean(s).replace(/([_\- .])[_\- .]+/g, '$1').replace(/^[_\- .]+|[_\- .]+$/g, '');
    s = s.replace(/[_\- .]+\u0001/, function (m) { return m.charAt(0) + '\u0001'; });
    if (!s.replace('\u0001', '')) s = (clean(t.clip || '') || camel(t.sequence) || 'Export') + (versioned ? '_\u0001' : '');
    var i = s.indexOf('\u0001');
    return versioned ? { prefix: s.slice(0, i) + 'v', suffix: s.slice(i + 1), versioned: true } : { prefix: s, suffix: '', versioned: false };
  }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Pick the file stem. files = names already in the folder, taken = stems already used in this batch (lower case).
  // opts.never = never overwrite: a template without {vNN} gets _v02, _v03… when the name is taken.
  function pick(tpl, t, files, taken, opts) {
    var p = parts(tpl, t), have = {}, low = function (x) { return String(x).toLowerCase(); };
    (files || []).forEach(function (f) { have[low(f).replace(/\.mp4$/, '')] = true; });
    taken = taken || {};
    if (p.versioned) {
      var re = new RegExp('^' + esc(low(p.prefix)) + '(\\d{1,4})' + esc(low(p.suffix)) + '$'), max = 0;
      Object.keys(have).concat(Object.keys(taken)).forEach(function (f) { var m = f.match(re); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      var n = max + 1, stem = p.prefix + pad(n) + p.suffix;
      taken[low(stem)] = true;
      return { stem: stem, version: n, existsBefore: max > 0, prev: max ? p.prefix + pad(max) + p.suffix : '' };
    }
    var base = p.prefix, s = base, k = 1, j = 1;
    while (taken[low(s)]) { k++; s = base + '_' + k; }                 // same name twice in one batch: _2, _3 (as before)
    var b2 = s;
    while (opts && opts.never && have[low(s)]) { j++; s = b2 + '_v' + pad(j); }   // never overwrite: _v02, _v03
    taken[low(s)] = true;
    return { stem: s, version: 0, existsBefore: !!have[low(s)], prev: '' };
  }

  var api = { ratio: ratio, camel: camel, parts: parts, pick: pick, date: date };
  // CEP mixed context also defines `module`: always publish on the window too
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.UAINaming = api; else if (root) root.UAINaming = api;
})(this);
