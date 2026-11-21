/* UGENTIC Export — panel logic
   One Media Encoder job per enabled V1 clip, cut straight from the sequence (In/Out = that clip).
   File name = clip name. Folder = the client's "Final Output" folder (or the one chosen with Browse). */
(function () {
  var nodeReq = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var fs = nodeReq('fs'), path = nodeReq('path'), os = nodeReq('os'), cp = nodeReq('child_process');
  var EXT_DIR = decodeURI(window.location.pathname).replace(/\/index\.html$/, '');
  var TEMPLATE = path.join(EXT_DIR, 'preset', 'base.epr');
  var PRESET_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'UGENTIC Export', 'presets');
  var REPO = 'agentixclaude/ugentic-export';     // updates are published here
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
      if (p.seqName !== lastSeq) { var h = document.createElement('div'); h.className = 'seqhead'; h.textContent = p.seqName + '  ·  ' + p.w + '×' + p.h; list.appendChild(h); lastSeq = p.seqName; }
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
  function makePreset(p) {
    fs.mkdirSync(PRESET_DIR, { recursive: true });
    var x = fs.readFileSync(TEMPLATE, 'utf8');
    x = setParam(x, 'ADBEVideoWidth', p.w);
    x = setParam(x, 'ADBEVideoHeight', p.h);
    if (p.h > 2304 || p.w > 4096) x = setParam(x, 'ADBEVideoMPEGProfileLevel', 62);   // H.264 5.2 cannot hold a 3840-tall frame
    x = setParam(x, 'ADBEVideoTargetBitrate', p.mbps + '.');
    x = setParam(x, 'ADBEVideoMaxBitrate', Math.min(300, Math.round(p.mbps * 1.2)) + '.');
    x = x.replace(/<PresetName>[^<]*<\/PresetName>/, '<PresetName>UGENTIC ' + p.w + 'x' + p.h + ' ' + p.mbps + 'Mbps</PresetName>');
    var file = path.join(PRESET_DIR, p.w + 'x' + p.h + '_' + p.mbps + 'Mbps.epr');
    fs.writeFileSync(file, x, 'utf8');
    return file;
  }

  // ---------- run ----------
  function status(t) { $('status').textContent = t; }
  async function refresh() {
    if (state.busy) return;
    var raw = await evalJsx('ugInfo()'), info = null;
    try { info = JSON.parse(raw); } catch (e) { info = { error: 'Premiere did not answer. Reopen the panel.' }; }
    if (info.error) { state.info = null; $('project').textContent = info.error; $('outdir').textContent = ''; render(); return; }
    var changed = !state.info || state.info.projectPath !== info.projectPath;
    state.info = info;
    $('project').textContent = info.projectName.replace(/\.prproj$/i, '');
    if (changed) loadOutDir();
    showOutDir(); render();
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
             + (done ? (st.autostart ? ' — encoding started.' : ' — press Start Queue in Media Encoder.') : ''));
    } catch (e) {
      status('Stopped: ' + e.message);
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
    https.get(url, { headers: { 'User-Agent': 'ugentic-export', 'Cache-Control': 'no-cache' } }, function (res) {
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
        var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugentic-export-'));
        var zip = path.join(tmp, 'update.zip'); fs.writeFileSync(zip, buf);
        cp.execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', tmp]);
        var root = fs.readdirSync(tmp).filter(function (n) { return fs.existsSync(path.join(tmp, n, 'panel', 'CSXS', 'manifest.xml')); })[0];
        if (!root) throw new Error('package is incomplete');
        var src = path.join(tmp, root, 'panel');
        if (fs.readFileSync(path.join(src, 'CSXS', 'manifest.xml'), 'utf8').indexOf('com.ugentic.export') < 0) throw new Error('wrong package');
        cp.execFileSync('/bin/cp', ['-R', src + '/.', EXT_DIR]);
        $('update').className = 'update done'; btn.style.display = 'none';
        $('updatetext').textContent = 'Updated to v' + localVersion() + '. Restart Premiere to use it.';
      } catch (e) { fail(e.message); }
    });
  }
  $('updatebtn').addEventListener('click', applyUpdate);
  checkUpdate();

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
  $('refresh').addEventListener('click', refresh);
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
  window.addEventListener('focus', refresh);
  refresh();
})();
