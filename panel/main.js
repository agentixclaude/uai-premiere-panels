/* UAI Smart Export — panel logic
   Export tab: one Media Encoder job per enabled V1 clip, cut straight from the sequence (In/Out = that clip).
   File name = clip name. Folder = the client's "Final Output" folder (or the one chosen with Browse). */
(function () {
  var nodeReq = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var fs = nodeReq('fs'), path = nodeReq('path'), os = nodeReq('os'), cp = nodeReq('child_process');
  var EXT_DIR = decodeURI(window.location.pathname).replace(/\/index\.html$/, '');
  var TEMPLATE = path.join(EXT_DIR, 'preset', 'base.epr');
  var PRESET_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'UAI Smart Export', 'presets');
  var REPO = 'agentixclaude/uai-smart-export';     // updates are published here
  var VERSION_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/panel/version.json';
  var ZIP_URL = 'https://codeload.github.com/' + REPO + '/zip/refs/heads/main';
  var https = nodeReq('https');
  var AUDIO_MBPS = 0.32;      // AAC 320 kbps
  var SAFETY = 0.95;          // aim 5% under the size cap (VBR drift)

  var $ = function (id) { return document.getElementById(id); };
  var state = { info: null, scope: 'all', outDir: '', plan: [], busy: false };

  function evalJsx(script) {
    return new Promise(function (resolve) { window.__adobe_cep__.evalScript(script, function (r) { resolve(r); }); });
  }
  var q = function (s) { return JSON.stringify(String(s)); };

  // ---------- export folder ----------
  function findFinalOutput(projectPath) {
    var projDir = path.dirname(projectPath);
    var bases = [path.dirname(projDir), path.dirname(path.dirname(projDir))];
    for (var i = 0; i < bases.length; i++) {
      try {
        var hit = fs.readdirSync(bases[i]).filter(function (n) { return /^final[ _-]?outputs?$/i.test(n); })[0];
        if (hit && fs.statSync(path.join(bases[i], hit)).isDirectory()) return path.join(bases[i], hit);
      } catch (e) {}
    }
    return path.join(path.dirname(projDir), 'Final Output');   // created on first export
  }
  function loadOutDir() {
    var p = state.info.projectPath, saved = null;
    try { saved = window.localStorage.getItem('out:' + p); } catch (e) {}
    state.outDir = saved || findFinalOutput(p);
  }
  function showOutDir() {
    var el = $('outdir');
    el.textContent = state.outDir; el.title = state.outDir;
    el.className = 'path' + (fs.existsSync(state.outDir) ? '' : ' missing');
  }

  // ---------- plan ----------
  function settings() {
    return { capGb: Math.max(0.2, parseFloat($('capgb').value) || 2), capMbps: Math.max(5, parseFloat($('capmbps').value) || 200),
             replace: $('replace').checked, autostart: $('autostart').checked };
  }
  function frameFor(w, h) {
    var longSide = Math.max(w, h);
    if (longSide <= 3840) return { w: w, h: h };
    var k = 3840 / longSide, r = function (v) { return Math.round(v * k / 2) * 2; };
    return { w: r(w), h: r(h) };
  }
  function buildPlan() {
    var st = settings(), plan = [], used = {};
    if (!state.info) return plan;
    state.info.sequences.forEach(function (s) {
      if (state.scope === 'active' && s.id !== state.info.activeId) return;
      var f = frameFor(s.w, s.h);
      s.clips.forEach(function (c) {
        if (!c.enabled) return;
        if (state.scope === 'selected' && !c.selected) return;
        var dur = c.end - c.start; if (dur <= 0) return;
        var stem = c.name.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[\/:*?"<>|]/g, '_');
        var n = used[stem.toLowerCase()] = (used[stem.toLowerCase()] || 0) + 1;
        if (n > 1) stem += '_' + n;
        var mbps = Math.max(1, Math.min(st.capMbps, Math.floor(st.capGb * SAFETY * 8000 / dur - AUDIO_MBPS)));
        var out = path.join(state.outDir, stem + '.mp4');
        plan.push({ seqId: s.id, seqName: s.name, stem: stem, start: c.start, end: c.end, dur: dur, mbps: mbps, w: f.w, h: f.h,
                    gb: (mbps + AUDIO_MBPS) * dur / 8000, out: out, exists: fs.existsSync(out), status: '' });
      });
    });
    return plan;
  }
  function fmtDur(s) { var m = Math.floor(s / 60), r = Math.round(s - m * 60); if (r === 60) { m++; r = 0; } return m + ':' + (r < 10 ? '0' : '') + r; }
  function render() {
    state.plan = buildPlan();
    var list = $('list'); list.innerHTML = '';
    var lastSeq = null, maxGb = 0;
    state.plan.forEach(function (p, i) {
      if (p.seqName !== lastSeq) { var h = document.createElement('div'); h.className = 'head'; h.innerHTML = '<span></span><span class="muted"></span>'; h.children[0].textContent = p.seqName; h.children[1].textContent = 'exports ' + p.w + '×' + p.h; list.appendChild(h); lastSeq = p.seqName; }
      var row = document.createElement('div'); row.className = 'clip' + (p.exists ? ' exists' : ''); row.id = 'clip' + i;
      row.innerHTML = '<span class="n"></span><span class="m"></span><span class="s"></span>';
      row.children[0].textContent = p.stem + '.mp4';
      row.children[1].textContent = fmtDur(p.dur) + '   ' + p.mbps + ' Mbps   ' + p.gb.toFixed(2) + ' GB';
      list.appendChild(row); maxGb = Math.max(maxGb, p.gb);
    });
    if (!state.plan.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = !state.info ? 'Open a saved project.' : state.scope === 'selected' ? 'Select clips in the timeline, then press Refresh.' : 'No enabled clips on V1.';
      list.appendChild(e);
    }
    var n = state.plan.length;
    $('count').textContent = n + (n === 1 ? ' clip' : ' clips');
    $('summary').textContent = n ? 'largest ≈ ' + maxGb.toFixed(2) + ' GB' : '';
    $('go').textContent = state.scope === 'all' ? 'Export all (' + n + ')' : 'Export ' + n + (n === 1 ? ' clip' : ' clips');
    $('go').disabled = !n || state.busy;
  }
  function setRow(i, cls, text) {
    var row = $('clip' + i); if (!row) return;
    row.className = 'clip ' + cls; row.children[2].textContent = text;
    row.scrollIntoView({ block: 'nearest' });
  }

  // ---------- preset ----------
  function setParam(xml, ident, value) {
    var re = new RegExp('(<ParamValue>)[^<]*(</ParamValue>(?:(?!</ExporterParam>)[\\s\\S])*?<ParamIdentifier>' + ident + '</ParamIdentifier>)');
    if (!re.test(xml)) throw new Error('preset is missing ' + ident);
    return xml.replace(re, function (m, a, b) { return a + value + b; });
  }
  function uuid() {
    var h = nodeReq('crypto').randomBytes(16).toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
  }
  function makePreset(p) {
    fs.mkdirSync(PRESET_DIR, { recursive: true });
    var x = fs.readFileSync(TEMPLATE, 'utf8');
    x = setParam(x, 'ADBEVideoWidth', p.w);
    x = setParam(x, 'ADBEVideoHeight', p.h);
    if (p.h > 2304 || p.w > 4096) x = setParam(x, 'ADBEVideoMPEGProfileLevel', 62);   // H.264 5.2 cannot hold a 3840-tall frame
    x = setParam(x, 'ADBEVideoTargetBitrate', p.mbps + '.');
    x = setParam(x, 'ADBEVideoMaxBitrate', Math.min(300, Math.round(p.mbps * 1.2)) + '.');
    x = x.replace(/<PresetName>[^<]*<\/PresetName>/, '<PresetName>UAI Smart Export ' + p.w + 'x' + p.h + ' ' + p.mbps + 'Mbps</PresetName>');
    // A fresh ID is essential: with the template's ID, Media Encoder swaps in the user's installed preset and ignores these values.
    x = x.replace(/<PresetID>[^<]*<\/PresetID>/, '<PresetID>' + uuid() + '</PresetID>');
    var file = path.join(PRESET_DIR, p.w + 'x' + p.h + '_' + p.mbps + 'Mbps.epr');
    fs.writeFileSync(file, x, 'utf8');
    return file;
  }

  // ---------- run ----------
  function status(t, tone) { var el = $('status'); el.textContent = t; el.className = 'status' + (tone ? ' tone-' + tone : ''); }
  // AC (agency client) = a folder in the project's path named like "AC#3 …" or "AC3_…"
  function isAcPath(p) { return String(p).split('/').some(function (seg) { return /^AC\s*#?\s*\d+([^0-9]|$)/i.test(seg) || /(^|[^A-Za-z])AC\s*#\s*\d+/i.test(seg); }); }
  function showAc() {
    var chip = $('acchip'); if (!state.info) { chip.hidden = true; return; }
    var ac = isAcPath(state.info.projectPath);
    chip.hidden = false; chip.textContent = ac ? 'AC client' : 'Client'; chip.className = 'chip' + (ac ? ' accent' : '');
    chip.title = ac ? 'Agency client: 4K, every file under the size cap' : 'Same rules: 4K, every file under the size cap';
  }
  async function refresh() {
    if (state.busy) return;
    var raw = await evalJsx('ugInfo()'), info = null;
    try { info = JSON.parse(raw); } catch (e) { info = { error: 'Premiere did not answer. Reopen the panel.' }; }
    if (info.error) { state.info = null; $('project').textContent = info.error; $('outdir').textContent = ''; showAc(); render(); return; }
    var changed = !state.info || state.info.projectPath !== info.projectPath;
    state.info = info;
    $('project').textContent = info.projectName.replace(/\.prproj$/i, '');
    if (changed) loadOutDir();
    showOutDir(); showAc(); render();
  }
  async function run() {
    if (state.busy || !state.plan.length) return;
    var st = settings(), plan = state.plan.slice(), done = 0, skipped = 0, failed = 0, saved = {};
    state.busy = true; $('go').disabled = true;
    try {
      fs.mkdirSync(state.outDir, { recursive: true }); showOutDir();
      for (var i = 0; i < plan.length; i++) {
        var p = plan[i];
        if (fs.existsSync(p.out)) {
          if (!st.replace) { skipped++; setRow(i, 'skipped', 'exists'); continue; }
          fs.unlinkSync(p.out);
        }
        status('Queuing ' + (i + 1) + ' of ' + plan.length + ' — ' + p.stem);
        setRow(i, '', '…');
        if (!(p.seqId in saved)) saved[p.seqId] = await evalJsx('ugGetInOut(' + q(p.seqId) + ')');
        var preset = makePreset(p);
        var r = await evalJsx('ugQueue(' + q(p.seqId) + ',' + p.start + ',' + p.end + ',' + q(p.out) + ',' + q(preset) + ')');
        if (/^OK:/.test(r)) { done++; setRow(i, 'queued', 'queued'); }
        else { failed++; setRow(i, 'failed', 'failed'); console.error(p.stem, r); state.lastError = r; }
      }
      for (var id in saved) {            // put each sequence's own In/Out back
        var io = String(saved[id]).split('|');
        if (io.length === 2 && isFinite(parseFloat(io[0])) && isFinite(parseFloat(io[1])))
          await evalJsx('ugSetInOut(' + q(id) + ',' + parseFloat(io[0]) + ',' + parseFloat(io[1]) + ')');
      }
      if (done && st.autostart) await evalJsx('ugStartQueue()');
      status(done + ' queued' + (skipped ? ', ' + skipped + ' skipped (file exists)' : '') + (failed ? ', ' + failed + ' failed: ' + String(state.lastError).replace(/^ERR:/, '') : '')
             + (done ? (st.autostart ? ' — encoding started.' : ' — press Start Queue in Media Encoder.') : ''), failed ? 'bad' : done ? 'ok' : 'warn');
    } catch (e) {
      status('Stopped: ' + e.message, 'bad');
    }
    state.busy = false; $('go').disabled = !state.plan.length;
  }

  // ---------- self-update (GitHub) ----------
  function localVersion() { try { return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'version.json'), 'utf8')).version; } catch (e) { return '0.0.0'; } }
  function newer(a, b) {            // is a newer than b
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d > 0; }
    return false;
  }
  function download(url, cb, hops) {
    https.get(url, { headers: { 'User-Agent': 'uai-smart-export', 'Cache-Control': 'no-cache' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 5) { res.resume(); return download(res.headers.location, cb, (hops || 0) + 1); }
      if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
      var chunks = []; res.on('data', function (d) { chunks.push(d); }); res.on('end', function () { cb(null, Buffer.concat(chunks)); });
    }).on('error', cb);
  }
  function checkUpdate() {
    $('ver').textContent = 'v' + localVersion();
    download(VERSION_URL + '?t=' + Date.now(), function (err, buf) {
      if (err) return;                                   // offline: stay quiet
      var remote; try { remote = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
      if (!remote.version || !newer(remote.version, localVersion())) return;
      $('updatetext').textContent = 'Version ' + remote.version + ' is available' + (remote.notes ? ' — ' + remote.notes : '');
      $('update').hidden = false;
    });
  }
  function applyUpdate() {
    if (state.busy) return;
    var btn = $('updatebtn'); btn.disabled = true; btn.textContent = 'Updating…';
    var fail = function (msg) { btn.disabled = false; btn.textContent = 'Try again'; $('updatetext').textContent = 'Update failed: ' + msg; };
    download(ZIP_URL, function (err, buf) {
      if (err) return fail(err.message);
      try {
        var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uai-smart-export-'));
        var zip = path.join(tmp, 'update.zip'); fs.writeFileSync(zip, buf);
        cp.execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', tmp]);
        var root = fs.readdirSync(tmp).filter(function (n) { return fs.existsSync(path.join(tmp, n, 'panel', 'CSXS', 'manifest.xml')); })[0];
        if (!root) throw new Error('package is incomplete');
        var src = path.join(tmp, root, 'panel');
        if (fs.readFileSync(path.join(src, 'CSXS', 'manifest.xml'), 'utf8').indexOf('com.uai.smartexport') < 0) throw new Error('wrong package');
        cp.execFileSync('/bin/cp', ['-R', src + '/.', EXT_DIR]);
        $('update').className = 'update done'; btn.style.display = 'none';
        $('updatetext').textContent = 'Updated to v' + localVersion() + '. Restart Premiere to use it.';
      } catch (e) { fail(e.message); }
    });
  }
  $('updatebtn').addEventListener('click', applyUpdate);
  checkUpdate();

  // ---------- tabs ----------
  var activeTab = 'export';
  function showTab(name) {
    activeTab = name;
    Array.prototype.forEach.call($('tabs').children, function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
    ['export', 'grade', 'review', 'setup'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    refreshTab();
  }
  function refreshTab() {
    if (activeTab === 'grade') gradeRefresh();
    if (activeTab === 'review') reviewRefresh();
  }
  Array.prototype.forEach.call($('tabs').children, function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

  // ---------- export: size check ----------
  function sizeCheck() {
    if (state.busy) return;
    var st = settings(), over = 0, missing = 0, ok = 0;
    state.plan.forEach(function (p, i) {
      if (!fs.existsSync(p.out)) { missing++; setRow(i, 'skipped', 'missing'); return; }
      var gb = fs.statSync(p.out).size / 1e9;
      if (gb > st.capGb) { over++; setRow(i, 'failed', gb.toFixed(2) + ' GB'); } else { ok++; setRow(i, 'ok', gb.toFixed(2) + ' GB'); }
    });
    status(ok + ' within ' + st.capGb + ' GB' + (over ? ', ' + over + ' over the limit' : '') + (missing ? ', ' + missing + ' not exported yet' : '') + '.', over ? 'bad' : missing ? 'warn' : 'ok');
  }
  $('sizecheck').addEventListener('click', sizeCheck);

  // ---------- grade (Lumetri Basic Correction of the first Lumetri on each clip) ----------
  var G_PARAMS = [['exposure', 'Exposure', 0.1], ['temperature', 'Temperature', 2], ['tint', 'Tint', 1], ['saturation', 'Saturation', 2], ['contrast', 'Contrast', 2],
                  ['highlights', 'Highlights', 5], ['shadows', 'Shadows', 5], ['whites', 'Whites', 5], ['blacks', 'Blacks', 5]];
  var G_ORDER = ['temperature', 'tint', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];   // order host.jsx expects
  var grade = { scope: 'selected', copied: null, last: null };
  function plural(n) { return n + (n === 1 ? ' clip' : ' clips'); }
  function gradeShow(d) {
    grade.last = d;
    if (d.error) { $('gtarget').textContent = d.error; return; }
    $('gtarget').textContent = d.count === 0 ? (grade.scope === 'selected' ? 'Select clips in the timeline, then click Refresh.' : 'No enabled clips on V1 of the active sequence.')
      : d.graded === 0 ? 'No Lumetri Color on ' + (d.count === 1 ? 'this clip.' : 'these clips.')
      : plural(d.graded) + (d.graded > 1 ? ' — values shown for ' + d.name : ' — ' + d.name);
    G_PARAMS.forEach(function (p) { var v = d.values ? d.values[p[0]] : null; $('gv-' + p[0]).textContent = (v === null || v === undefined) ? '–' : v; });
    var on = d.graded > 0;
    Array.prototype.forEach.call($('gparams').querySelectorAll('button'), function (b) { b.disabled = !on; });
  }
  async function gradeRead(scope) {
    var r = await evalJsx('ugGradeRead(' + q(scope) + ')');
    try { return JSON.parse(r); } catch (e) { return { error: 'Premiere did not answer. Reopen the panel.' }; }
  }
  async function gradeRefresh() { gradeShow(await gradeRead(grade.scope)); }
  G_PARAMS.forEach(function (p) {
    var row = document.createElement('div'); row.className = 'prow';
    row.innerHTML = '<span></span><span class="v" id="gv-' + p[0] + '">–</span><button disabled>−</button><button disabled>+</button>';
    row.children[0].textContent = p[1];
    [-1, 1].forEach(function (sign, i) {
      row.children[2 + i].title = (sign > 0 ? '+' : '−') + p[2];
      row.children[2 + i].addEventListener('click', async function () {
        var r = await evalJsx('ugGradeNudge(' + q(grade.scope) + ',' + q(p[0]) + ',' + (sign * p[2]) + ')'), d;
        try { d = JSON.parse(r); } catch (e) { d = { error: 'Premiere did not answer.' }; }
        gradeShow(d);
        if (!d.error) $('gstatus').textContent = p[1] + ' ' + (sign > 0 ? '+' : '−') + p[2] + ' on ' + plural(d.graded) + '.';
      });
    });
    $('gparams').appendChild(row);
  });
  Array.prototype.forEach.call($('gscope').children, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call($('gscope').children, function (x) { x.className = x === b ? 'on' : ''; });
      grade.scope = b.getAttribute('data-v'); gradeRefresh();
    });
  });
  function gradeCsv() { return G_ORDER.map(function (k) { var v = grade.copied.values[k]; return (v === null || v === undefined) ? 'x' : v; }).join(','); }
  $('gcopy').addEventListener('click', async function () {
    var d = await gradeRead('selected');
    if (d.error || !d.graded) { $('gstatus').textContent = d.error || 'Select one graded clip in the timeline first.'; return; }
    grade.copied = { name: d.name, camera: d.camera, values: d.values };
    $('gclip').textContent = 'Copied from ' + d.name + ' (camera ' + d.camera + ').';
    $('gpaste').disabled = false; $('gpastecam').disabled = false;
    $('gpastecam').textContent = 'Paste to all ' + d.camera + ' clips';
    $('gstatus').textContent = '';
  });
  async function gradePaste(scope) {
    if (!grade.copied) return;
    var r = await evalJsx('ugGradeApply(' + q(scope) + ',' + q(grade.copied.camera) + ',' + q(gradeCsv()) + ')');
    $('gstatus').textContent = /^OK:/.test(r) ? 'Pasted to ' + plural(parseInt(r.slice(3), 10)) + '.' : 'Paste failed: ' + String(r).replace(/^ERR:/, '');
    gradeRefresh();
  }
  $('gpaste').addEventListener('click', function () { gradePaste('selected'); });
  $('gpastecam').addEventListener('click', function () { gradePaste('camera'); });

  // ---------- review ----------
  var review = { data: null, sscope: 'selected' };
  function isReview(mk) { return /review/i.test(mk.name + ' ' + mk.comments); }
  function shown() { return review.data ? review.data.markers.filter(function (mk) { return $('rall').checked || isReview(mk); }) : []; }
  async function reviewRefresh() {
    var r = await evalJsx('ugMarkers()'), d;
    try { d = JSON.parse(r); } catch (e) { d = { error: 'Premiere did not answer. Reopen the panel.' }; }
    var list = $('rlist'); list.innerHTML = '';
    if (d.error) { review.data = null; list.innerHTML = '<div class="empty"></div>'; list.firstChild.textContent = d.error; return; }
    review.data = d;
    var rows = shown();
    if (!rows.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = d.markers.length ? 'No review markers in ' + d.sequence + '. Every IN and OUT passed.' : 'No markers in ' + d.sequence + '.';
      list.appendChild(e);
    }
    rows.forEach(function (mk) {
      var row = document.createElement('div'); row.className = 'mrow' + (isReview(mk) ? ' review' : '');
      row.innerHTML = '<span class="t"></span><span class="n"></span><span class="c"></span>';
      row.children[0].textContent = fmtDur(mk.seconds); row.children[1].textContent = mk.name; row.children[2].textContent = mk.comments;
      row.addEventListener('click', function () { goMarker(mk); });
      list.appendChild(row);
    });
  }
  async function goMarker(mk) {
    await evalJsx('ugGoto(' + q(mk.ticks) + ')');
    if (review.data) review.data.position = mk.ticks;
    $('rstatus').textContent = mk.name + ' — ' + mk.comments;
  }
  function step(dir) {
    var rows = shown(); if (!rows.length) { $('rstatus').textContent = 'Nothing to review here.'; return; }
    var pos = Number(review.data.position), pick = null;
    if (dir > 0) { pick = rows.filter(function (mk) { return Number(mk.ticks) > pos; })[0] || rows[0]; }
    else { var before = rows.filter(function (mk) { return Number(mk.ticks) < pos; }); pick = before[before.length - 1] || rows[rows.length - 1]; }
    goMarker(pick);
  }
  $('rnext').addEventListener('click', function () { step(1); });
  $('rprev').addEventListener('click', function () { step(-1); });
  $('rall').addEventListener('change', reviewRefresh);
  Array.prototype.forEach.call($('sscope').children, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call($('sscope').children, function (x) { x.className = x === b ? 'on' : ''; });
      review.sscope = b.getAttribute('data-v');
    });
  });
  function stillsDir() { return state.info ? path.join(path.dirname(path.dirname(state.info.projectPath)), 'QC Stills') : ''; }
  $('rstills').addEventListener('click', async function () {
    if (state.busy) return;
    var info; try { info = JSON.parse(await evalJsx('ugInfo()')); } catch (e) { info = { error: 'Premiere did not answer.' }; }
    if (info.error) { $('rstatus').textContent = info.error; return; }
    state.info = info; await reviewRefresh();
    var seq = info.sequences.filter(function (s) { return s.id === info.activeId; })[0];
    if (!seq) { $('rstatus').textContent = 'Open a sequence first.'; return; }
    var marks = review.data ? review.data.markers.filter(isReview) : [];
    var clips = seq.clips.filter(function (c) {
      if (!c.enabled) return false;
      if (review.sscope === 'selected') return c.selected;
      if (review.sscope === 'review') return marks.some(function (mk) { return mk.seconds >= c.start - 0.001 && mk.seconds <= c.end + 0.001; });
      return true;
    });
    if (!clips.length) { $('rstatus').textContent = review.sscope === 'selected' ? 'Select clips in the timeline first.' : 'No matching clips in ' + seq.name + '.'; return; }
    state.busy = true; $('rstills').disabled = true;
    try {
      var dir = stillsDir(); fs.mkdirSync(dir, { recursive: true });
      var frame = Number(seq.timebase), failed = 0;
      for (var i = 0; i < clips.length; i++) {
        var c = clips[i], stem = c.name.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[\/:*?"<>|]/g, '_');
        $('rstatus').textContent = 'Saving ' + (i + 1) + ' of ' + clips.length + ' — ' + stem;
        var a = await evalJsx('ugStill(' + q(c.startTicks) + ',' + q(path.join(dir, stem + '_IN')) + ')');
        var b = await evalJsx('ugStill(' + q(String(Number(c.endTicks) - frame)) + ',' + q(path.join(dir, stem + '_OUT')) + ')');
        if (a !== 'OK' || b !== 'OK') failed++;
      }
      $('rstatus').textContent = (clips.length - failed) * 2 + ' stills saved to ' + dir + (failed ? ' (' + failed + ' clips failed)' : '') + '.';
    } catch (e) { $('rstatus').textContent = 'Stopped: ' + e.message; }
    state.busy = false; $('rstills').disabled = false;
  });
  $('ropen').addEventListener('click', function () {
    var dir = stillsDir(); if (!dir) return;
    cp.execFile('/usr/bin/open', [fs.existsSync(dir) ? dir : path.dirname(dir)]);
  });

  // ---------- setup ----------
  $('scolumns').addEventListener('click', async function () {
    var xml; try { xml = fs.readFileSync(path.join(EXT_DIR, 'columns', 's-log.xml'), 'utf8'); } catch (e) { $('sstatus').textContent = 'Column file is missing. Reinstall the panel.'; return; }
    var r = await evalJsx('ugColumns(' + q(xml) + ')');
    $('sstatus').textContent = r === 'OK' ? 'S-log columns applied to the Project panel.' : 'Could not apply: ' + String(r).replace(/^ERR:/, '');
  });

  // ---------- wiring ----------
  ['capgb', 'capmbps', 'replace', 'autostart'].forEach(function (id) {
    var el = $(id), key = 'opt:' + id;
    try { var v = window.localStorage.getItem(key); if (v !== null) { if (el.type === 'checkbox') el.checked = v === '1'; else el.value = v; } } catch (e) {}
    el.addEventListener('change', function () {
      try { window.localStorage.setItem(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value); } catch (e) {}
      if (!state.busy) render();
    });
  });
  Array.prototype.forEach.call($('scope').children, function (b) {
    b.addEventListener('click', function () {
      if (state.busy) return;
      Array.prototype.forEach.call($('scope').children, function (x) { x.className = x === b ? 'on' : ''; });
      state.scope = b.getAttribute('data-v'); refresh();
    });
  });
  $('refresh').addEventListener('click', function () { refresh(); refreshTab(); });
  $('browse').addEventListener('click', async function () {
    if (!state.info || state.busy) return;
    var start = fs.existsSync(state.outDir) ? state.outDir : path.dirname(state.outDir);
    var picked = await evalJsx('ugPickFolder(' + q(start) + ')');
    if (picked && picked !== 'EvalScript error.') {
      state.outDir = picked;
      try { window.localStorage.setItem('out:' + state.info.projectPath, picked); } catch (e) {}
      showOutDir(); render();
    }
  });
  $('resetdir').addEventListener('click', function () {
    if (!state.info || state.busy) return;
    try { window.localStorage.removeItem('out:' + state.info.projectPath); } catch (e) {}
    loadOutDir(); showOutDir(); render();
  });
  $('reveal').addEventListener('click', function () {
    if (!state.outDir) return;
    var target = fs.existsSync(state.outDir) ? state.outDir : path.dirname(state.outDir);
    cp.execFile('/usr/bin/open', [target]);
  });
  $('go').addEventListener('click', run);
  window.addEventListener('focus', function () { refresh(); refreshTab(); });
  refresh();
})();
