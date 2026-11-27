/* UAI Smart Export — Normal export › Clips by cuts
   One sequence can hold several finished videos edited one after another. Each video = one clip.
   The longest layer decides a clip (background, BGM, an adjustment layer named "Clip 1"…); every shorter
   layer that sits inside it (cuts, B-roll, captions, SFX) belongs to that clip.

   1. Layers named exactly "Clip N" (adjustment / label layers): when there are 2 or more, they ARE the clips.
   2. Otherwise, longest first: a layer becomes a new clip unless it overlaps a clip already found
      (overlap up to 10% of its own length is allowed, so a cross-dissolve between two videos does not hide one).
   3. Layers running ≥ 95% of the whole timeline (logo, watermark, one long music bed) are ignored first,
      as long as 2 or more clips are still found without them.
   Clips shorter than 1 s are dropped (stray SFX in a gap). Ranges are whole frames [a, b). */
(function (root) {
  var TICKS = 254016000000;

  function frames(seq) {
    var tb = Number(seq.timebase);
    return (seq.items || []).map(function (it) {
      return { n: String(it.n || ''), t: it.t, a: Math.round(Number(it.s) / tb), b: Math.round(Number(it.e) / tb) };
    }).filter(function (it) { return it.b - it.a > 0; });
  }
  function overlap(x, y) { return Math.min(x.b, y.b) - Math.max(x.a, y.a); }
  function greedy(list, minLen) {
    var sorted = list.slice().sort(function (x, y) { return (y.b - y.a) - (x.b - x.a) || x.a - y.a; }), segs = [];
    sorted.forEach(function (it) {
      var len = it.b - it.a;
      if (len < minLen) return;
      var tol = Math.max(1, Math.round(0.1 * len));
      for (var i = 0; i < segs.length; i++) if (overlap(segs[i], it) > tol) return;
      segs.push(it);
    });
    return segs.sort(function (x, y) { return x.a - y.a; });
  }

  // -> [{ a, b, label, layer, track, layers }]   (a/b in frames of the sequence)
  function detect(seq) {
    var items = frames(seq);
    if (!items.length) return [];
    var fps = TICKS / Number(seq.timebase), minLen = Math.max(1, Math.round(fps));
    var segs, how;
    var named = items.filter(function (it) { return /^clip\s*\d+$/i.test(it.n.trim()); });
    if (named.length >= 2) { segs = greedy(named, 1); how = 'named'; }
    else {
      var a0 = Math.min.apply(null, items.map(function (it) { return it.a; }));
      var b0 = Math.max.apply(null, items.map(function (it) { return it.b; }));
      var span = b0 - a0;
      segs = greedy(items.filter(function (it) { return it.b - it.a < 0.95 * span; }), minLen); how = 'longest';
      if (segs.length < 2) segs = greedy(items, minLen);
    }
    return segs.map(function (s, i) {
      var m = s.n.trim().match(/^clip\s*(\d+)$/i);
      return { a: s.a, b: s.b, label: how === 'named' && m ? parseInt(m[1], 10) : i + 1, layer: s.n, track: s.t,
               layers: items.filter(function (it) { return overlap(it, s) > 0; }).length };
    });
  }

  var api = { detect: detect, TICKS: TICKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UAICuts = api;
})(this);
