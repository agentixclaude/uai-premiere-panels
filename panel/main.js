/* UAI Smart Export — panel logic
   Project type "Color grading export": one Media Encoder job per enabled V1 clip, cut straight from the sequence
   (In/Out = that clip), 4K, under the size cap. File name = clip name.
   Project type "Normal export" (1.9.0): one job per sequence (whole timeline) or per clip found by cuts (cuts.js),
   match source, medium bitrate, no cap, no edge offset. File name = sequence name (+ _ClipNN).
   Folder = the client's "Final Output" folder (or the one chosen with Browse). */
(function () {
  var nodeReq = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var fs = nodeReq('fs'), path = nodeReq('path'), os = nodeReq('os'), cp = nodeReq('child_process');
  var EXT_DIR = decodeURI(window.location.pathname).replace(/\/index\.html$/, '');
  var TEMPLATE = path.join(EXT_DIR, 'preset', 'base.epr');
  var PRESET_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'UAI Smart Export', 'presets');
  var REPO = 'agentixclaude/uai-premiere-panels';     // updates are published here
  var VERSION_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/panel/version.json';
  var ZIP_URL = 'https://codeload.github.com/' + REPO + '/zip/refs/heads/main';
  var https = nodeReq('https');
  var AUDIO_MBPS = 0.32;      // AAC 320 kbps
  var SAFETY = 0.95;          // aim 5% under the size cap (VBR drift)

  var $ = function (id) { return document.getElementById(id); };
  var GO_ICON = (document.querySelector('#go svg') || { outerHTML: '' }).outerHTML;
  var FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].filter(function (f) { try { return fs.existsSync(f); } catch (e) { return false; } })[0] || null;
  var state = { info: null, scope: 'all', outDir: '', plan: [], busy: false,
                mode: 'grade', nscope: 'seq', ninfo: null, off: {} };
  try { state.mode = window.localStorage.getItem('opt:mode') === 'normal' ? 'normal' : 'grade';
        state.nscope = window.localStorage.getItem('opt:nscope') === 'cuts' ? 'cuts' : 'seq'; } catch (e) {}
  var BPP = 0.16;             // Normal export "medium bitrate": bits per pixel per frame (1080×1920 @30 ≈ 10 Mbps, 4K @30 ≈ 40)

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
    state.outDir = saved || defaultOutDir(p);
  }
  function defaultOutDir(p) {
    var fo = findFinalOutput(p);
    if (state.mode === 'normal' && !fs.existsSync(fo)) return path.join(path.dirname(p), 'Exports');
    return fo;
  }
  function showOutDir() {
    var el = $('outdir');
    el.textContent = '\u200E' + state.outDir + '\u200E'; el.title = state.outDir;   // LRM keeps slashes in order under rtl ellipsis
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
  function safeStem(n) { return String(n).replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[\/:*?"<>|]/g, '_').trim() || 'Sequence'; }
  // Normal export: match source frame (≤ 4K long side), sequence frame rate, VBR 1-pass at a medium bitrate
  function buildNormalPlan() {
    var plan = [], used = {};
    if (!state.info || !state.ninfo) return plan;
    var nestedNames = {};
    state.ninfo.sequences.forEach(function (s) { (s.nested || []).forEach(function (n) { nestedNames[n] = true; }); });
    state.ninfo.sequences.forEach(function (s) {
      if (!s.items || !s.items.length) return;
      var tb = Number(s.timebase), fps = UAICuts.TICKS / tb, f = frameFor(s.w, s.h);
      var mbps = Math.max(6, Math.min(60, Math.round(f.w * f.h * fps * BPP / 1e6)));
      var nested = !!nestedNames[s.name], seqStem = safeStem(s.name);
      var add = function (stem, inF, outF, dur, key, sub) {
        var low = stem.toLowerCase(), n = used[low] = (used[low] || 0) + 1;
        if (n > 1) stem += '_' + n;
        var out = path.join(state.outDir, stem + '.mp4');
        plan.push({ normal: true, key: key, on: !(key in state.off ? state.off[key] : nested), nested: nested, sub: sub,
                    seqId: s.id, seqName: s.name, stem: stem, inF: inF, outF: outF, dur: dur, fpsTicks: tb, fps: fps,
                    mbps: mbps, maxMbps: Math.round(mbps * 1.3), w: f.w, h: f.h, gb: (mbps + AUDIO_MBPS) * dur / 8000,
                    out: out, exists: fs.existsSync(out), status: '' });
      };
      if (state.nscope === 'seq') {
        var endT = Number(s.end);
        if (!(endT > 0)) endT = Math.max.apply(null, s.items.map(function (it) { return Number(it.e); }));
        var dur = endT / UAICuts.TICKS; if (!(dur > 0)) return;
        add(seqStem, -1, -1, dur, s.id, 'whole timeline');
      } else {
        UAICuts.detect(s).forEach(function (c, i) {
          var pad = c.label < 10 ? '0' + c.label : String(c.label);
          add(seqStem + '_Clip' + pad, c.a, c.b, (c.b - c.a) / fps, s.id + ':' + c.a + '-' + c.b,
              'longest: ' + c.layer + ' (' + c.track + ') · ' + c.layers + ' layers');
        });
      }
    });
    return plan;
  }
  function buildPlan() {
    if (state.mode === 'normal') return buildNormalPlan();
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
        plan.push({ seqId: s.id, seqName: s.name, stem: stem, start: c.start, end: c.end, dur: dur, srcIn: c.inPoint, srcOut: c.outPoint, mbps: mbps, w: f.w, h: f.h,
                    gb: (mbps + AUDIO_MBPS) * dur / 8000, out: out, exists: fs.existsSync(out), status: '' });
      });
    });
    return plan;
  }
  function fmtDur(s) { var m = Math.floor(s / 60), r = Math.round(s - m * 60); if (r === 60) { m++; r = 0; } return m + ':' + (r < 10 ? '0' : '') + r; }
  function fmtFrames(fr, fps) { var s = fr / fps, h = Math.floor(s / 3600); return (h ? h + ':' + (Math.floor(s / 60) % 60 < 10 ? '0' : '') : '') + fmtDur(h ? s - h * 3600 : s); }
  function selected() { return state.plan.filter(function (p) { return p.on !== false; }); }
  function renderNormal() {
    var list = $('list'), lastSeq = null, head = null, total = 0;
    state.plan.forEach(function (p, i) {
      if (p.seqId !== lastSeq) {
        head = document.createElement('div'); head.className = 'head sel';
        head.innerHTML = '<label><input type="checkbox"><span></span></label><span class="muted"></span>';
        head.querySelector('label span').textContent = p.seqName + (p.nested ? ' · nested' : '');
        head.children[1].textContent = p.w + '×' + p.h + ' · ' + (Math.round(p.fps * 100) / 100) + ' fps · ' + p.mbps + ' Mbps';
        var kids = state.plan.filter(function (x) { return x.seqId === p.seqId; });
        var hb = head.querySelector('input'); hb.checked = kids.every(function (x) { return x.on; }); hb.indeterminate = !hb.checked && kids.some(function (x) { return x.on; });
        hb.addEventListener('change', (function (kids, box) { return function () { if (state.busy) return; kids.forEach(function (x) { state.off[x.key] = !box.checked; }); render(); }; })(kids, hb));
        list.appendChild(head); lastSeq = p.seqId;
      }
      var row = document.createElement('label'); row.className = 'clip sel' + (p.on ? '' : ' off'); row.id = 'clip' + i;
      row.innerHTML = '<input type="checkbox"><span class="n"></span><span class="t"></span><span class="chip"></span>';
      var cb = row.children[0]; cb.checked = p.on; cb.disabled = state.busy;
      cb.addEventListener('change', function () { if (state.busy) return; state.off[p.key] = !cb.checked; render(); });
      row.children[1].textContent = p.stem;
      row.children[2].textContent = p.inF < 0 ? fmtDur(p.dur) : fmtFrames(p.inF, p.fps) + ' → ' + fmtFrames(p.outF, p.fps);
      row.title = p.stem + '.mp4 · ' + p.sub + ' · ' + fmtDur(p.dur) + ' · ' + p.mbps + ' Mbps · ≈' + p.gb.toFixed(2) + ' GB';
      var chip = row.children[3];
      if (p.exists) { chip.textContent = 'exists'; chip.className = 'chip warn'; } else { chip.textContent = p.on ? 'ready' : 'off'; chip.className = 'chip'; }
      list.appendChild(row); if (p.on) total += p.dur;
    });
    if (!state.plan.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = !state.info ? 'Open a saved project.' : !state.ninfo ? 'Reading sequences…' : state.nscope === 'cuts' ? 'No clips found: the sequences are empty.' : 'No sequence has anything on its tracks.';
      list.appendChild(e);
    }
    var n = selected().length, unit = state.nscope === 'seq' ? ['video', 'videos'] : ['clip', 'clips'];
    $('count').textContent = n + ' of ' + state.plan.length + ' ' + (state.plan.length === 1 ? unit[0] : unit[1]);
    $('summary').textContent = n ? fmtDur(total) + ' total' : '';
    $('go').innerHTML = GO_ICON + '<span></span>'; $('go').lastChild.textContent = 'Export ' + n;
    $('go').disabled = !n || state.busy;
  }
  function render() {
    state.plan = buildPlan();
    syncMode();
    if (state.mode === 'normal') { $('list').innerHTML = ''; return renderNormal(); }
    var list = $('list'); list.innerHTML = '';
    var lastSeq = null, maxGb = 0;
    state.plan.forEach(function (p, i) {
      if (p.seqName !== lastSeq) { var h = document.createElement('div'); h.className = 'head'; h.innerHTML = '<span></span><span class="muted"></span>'; h.children[0].textContent = p.seqName; h.children[1].textContent = 'exports ' + p.w + '×' + p.h; list.appendChild(h); lastSeq = p.seqName; }
      var row = document.createElement('div'); row.className = 'clip'; row.id = 'clip' + i;
      row.innerHTML = '<span class="n"></span><span class="t"></span><span class="chip"></span>';
      row.children[0].textContent = p.stem;
      var a = isFinite(p.srcIn) ? p.srcIn : p.start, b = isFinite(p.srcOut) ? p.srcOut : p.end;
      row.children[1].textContent = fmtDur(a) + ' → ' + fmtDur(b);
      row.title = p.stem + '.mp4 · ' + fmtDur(p.dur) + ' · ' + p.mbps + ' Mbps · ≈' + p.gb.toFixed(2) + ' GB';
      if (p.exists) { row.children[2].textContent = 'exists'; row.children[2].className = 'chip warn'; }
      else { row.children[2].textContent = 'ready'; }
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
    $('go').innerHTML = GO_ICON + '<span></span>'; $('go').lastChild.textContent = state.scope === 'all' ? 'Export all (' + n + ')' : 'Export ' + n;
    $('go').disabled = !n || state.busy;
  }
  var TONE = { queued: 'ok', ok: 'ok', skipped: 'warn', failed: 'bad', '': 'busy' };
  function setRow(i, cls, text) {
    var row = $('clip' + i); if (!row) return;
    var chip = row.querySelector('.chip');
    row.className = 'clip ' + (row.querySelector('input') ? 'sel ' : '') + cls; chip.textContent = text; chip.className = 'chip ' + (TONE[cls] || '');
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
    if (p.normal) {
      x = setParam(x, 'ADBEVideoMaxBitrate', p.maxMbps + '.');
      x = setParam(x, 'ADBEVideoBitrateEncoding', 1);           // VBR 1-pass (social delivery, faster than 2-pass)
      x = setParam(x, 'ADBEVideoFPS', p.fpsTicks);              // sequence frame rate
    } else x = setParam(x, 'ADBEVideoMaxBitrate', Math.min(300, Math.round(p.mbps * 1.2)) + '.');
    x = x.replace(/<PresetName>[^<]*<\/PresetName>/, '<PresetName>UAI ' + (p.normal ? 'Normal Export ' : 'Smart Export ') + p.w + 'x' + p.h + ' ' + p.mbps + 'Mbps</PresetName>');
    // A fresh ID is essential: with the template's ID, Media Encoder swaps in the user's installed preset and ignores these values.
    x = x.replace(/<PresetID>[^<]*<\/PresetID>/, '<PresetID>' + uuid() + '</PresetID>');
    var file = path.join(PRESET_DIR, (p.normal ? 'N_' + Math.round(p.fps * 1000) + '_' : '') + p.w + 'x' + p.h + '_' + p.mbps + 'Mbps.epr');
    fs.writeFileSync(file, x, 'utf8');
    return file;
  }

  // ---------- run ----------
  function status(t, tone) { var el = $('status'); el.textContent = t; el.className = 'status' + (tone ? ' tone-' + tone : ''); }
  // AC (agency client) = a folder in the project's path named like "AC#3 …" or "AC3_…"
  function isAcPath(p) { return String(p).split('/').some(function (seg) { return /^AC\s*#?\s*\d+([^0-9]|$)/i.test(seg) || /(^|[^A-Za-z])AC\s*#\s*\d+/i.test(seg); }); }
  function showAc() {
    var chip = $('acchip'); if (!state.info) { chip.hidden = true; return; }
    if (state.mode === 'normal') { chip.hidden = false; chip.textContent = 'Normal'; chip.className = 'chip'; chip.title = 'Normal export: match source, medium bitrate, no size cap'; return; }
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
    if (changed) state.off = {};
    if (state.mode === 'normal') {
      var nraw = await evalJsx('ugNormalInfo()'), ni = null;
      try { ni = JSON.parse(nraw); } catch (e) { ni = null; }
      state.ninfo = ni && !ni.error ? ni : null;
      if (ni && ni.error) status(ni.error, 'bad');
    }
    $('project').textContent = info.projectName.replace(/\.prproj$/i, '');
    if (changed) loadOutDir();
    showOutDir(); showAc(); render();
  }
  async function run() {
    if (state.busy || !state.plan.length) return;
    var st = settings(), plan = state.plan.slice(), done = 0, skipped = 0, failed = 0, saved = {}, todo = selected().length, k = 0;
    state.busy = true; $('go').disabled = true;
    try {
      fs.mkdirSync(state.outDir, { recursive: true }); showOutDir();
      for (var i = 0; i < plan.length; i++) {
        var p = plan[i];
        if (p.on === false) continue;
        k++;
        if (fs.existsSync(p.out)) {
          if (!st.replace) { skipped++; setRow(i, 'skipped', 'exists'); continue; }
          fs.unlinkSync(p.out);
        }
        status('Queuing ' + k + ' of ' + todo + ' — ' + p.stem);
        setRow(i, '', '…');
        if (!(p.seqId in saved) && !(p.normal && p.inF < 0)) saved[p.seqId] = await evalJsx('ugGetInOut(' + q(p.seqId) + ')');
        var preset = makePreset(p);
        var r = p.normal
          ? await evalJsx('ugQueueFrames(' + q(p.seqId) + ',' + p.inF + ',' + p.outF + ',' + q(p.out) + ',' + q(preset) + ')')
          : await evalJsx('ugQueue(' + q(p.seqId) + ',' + p.start + ',' + p.end + ',' + q(p.out) + ',' + q(preset) + ')');
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
    state.busy = false; $('go').disabled = !selected().length;
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

  // ---------- results: verify every output file (exists, H.264, frame size, size cap) ----------
  function probe(file) {
    return new Promise(function (resolve) {
      if (!FFPROBE) return resolve(null);
      cp.execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], function (err, out) {
        if (err) return resolve({ error: 'unreadable' });
        try { resolve((JSON.parse(out).streams || [])[0] || { error: 'no video stream' }); } catch (e) { resolve({ error: 'unreadable' }); }
      });
    });
  }
  async function verify() {
    if (state.busy) return;
    showTab('results');
    var st = settings(), plan = state.plan.slice(), rows = [], box = $('vlist');
    var idx = plan.map(function (p, i) { return i; }).filter(function (i) { return plan[i].on !== false; });
    if (!plan.length) { box.innerHTML = '<div class="empty">Nothing to check: no clips listed on the Export tab.</div>'; vstatus('', ''); return; }
    state.busy = true; $('verify').disabled = true; $('sizecheck').disabled = true;
    for (var j = 0; j < idx.length; j++) {
      var i = idx[j], p = plan[i], r = { name: p.stem + '.mp4', verified: false, label: 'missing', detail: 'not exported yet' };
      vstatus('Checking ' + (j + 1) + ' of ' + idx.length + ' — ' + r.name, '');
      if (fs.existsSync(p.out)) {
        var bytes = fs.statSync(p.out).size, gb = bytes / 1e9, info = await probe(p.out), problems = [];
        if (!p.normal && gb > st.capGb) problems.push('over ' + st.capGb + ' GB');
        if (info && !info.error) {
          if (info.codec_name !== 'h264') problems.push(info.codec_name + ', not H.264');
          if (info.width !== p.w || info.height !== p.h) problems.push(info.width + '×' + info.height + ', expected ' + p.w + '×' + p.h);
        } else if (info && info.error) problems.push(info.error);
        r.detail = gb.toFixed(2) + ' GB' + (info && !info.error ? ' · ' + info.codec_name.toUpperCase() + ' · ' + info.width + '×' + info.height : ' · codec not checked (ffprobe missing)') + (problems.length ? ' · ' + problems.join(', ') : '');
        r.verified = !problems.length && !!info;
        r.label = problems.length ? 'fix' : info ? 'verified' : 'size ok';
        setRow(i, problems.length ? 'failed' : 'ok', gb.toFixed(2) + ' GB');
      } else setRow(i, 'skipped', 'missing');
      rows.push(r);
    }
    box.innerHTML = '';
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'res';
      row.innerHTML = '<span class="n"></span><span class="d"></span><span class="chip"></span>';
      row.children[0].textContent = r.name; row.children[1].textContent = r.detail; row.children[2].textContent = r.label;
      row.children[2].className = 'chip ' + (r.verified ? 'ok' : r.label === 'missing' ? '' : 'warn');
      box.appendChild(row);
    });
    var ok = rows.filter(function (r) { return r.verified; }).length, missing = rows.filter(function (r) { return r.label === 'missing'; }).length, bad = rows.length - ok - missing;
    $('vok').textContent = ok + ' verified'; $('vbad').textContent = bad + ' to fix' + (missing ? ' · ' + missing + ' not exported' : '');
    $('vwhen').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    vstatus(ok + ' of ' + rows.length + ' verified' + (bad ? ', ' + bad + ' need fixing' : '') + (missing ? ', ' + missing + ' not exported yet' : '') + '.', bad ? 'bad' : missing ? 'warn' : 'ok');
    state.busy = false; $('verify').disabled = false; $('sizecheck').disabled = false;
  }
  function vstatus(t, tone) { var el = $('vstatus'); el.textContent = t; el.className = 'status' + (tone ? ' tone-' + tone : ''); }
  $('sizecheck').addEventListener('click', verify);
  $('verify').addEventListener('click', verify);
  $('vopen').addEventListener('click', function () { if (state.outDir) cp.execFile('/usr/bin/open', [fs.existsSync(state.outDir) ? state.outDir : path.dirname(state.outDir)]); });

  // ---------- tabs ----------
  function showTab(name) {
    Array.prototype.forEach.call($('tabs').children, function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
    ['export', 'results', 'about'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
  }
  Array.prototype.forEach.call($('tabs').children, function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });
  $('probestate').textContent = FFPROBE ? 'ffprobe found: codec and frame size are verified' : 'ffprobe missing: only the size is verified (brew install ffmpeg)';
  $('probestate').className = 'chip ' + (FFPROBE ? 'ok' : 'warn');

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
  // ---------- project type (1.9.0) ----------
  function syncMode() {
    var normal = state.mode === 'normal';
    Array.prototype.forEach.call($('mode').children, function (b) { b.className = b.getAttribute('data-v') === state.mode ? 'on' : ''; });
    Array.prototype.forEach.call($('nscope').children, function (b) { b.className = b.getAttribute('data-v') === state.nscope ? 'on' : ''; });
    $('scope').hidden = normal; $('nscope').hidden = !normal;
    Array.prototype.forEach.call(document.querySelectorAll('.gradeonly'), function (el) { el.hidden = normal; });
    $('selall').hidden = !normal; $('selactive').hidden = !normal;
    $('setend').textContent = normal ? 'H.264 · match source · medium bitrate · no size cap' : "H.264 · 4K in the sequence's orientation";
    $('modehint').textContent = normal ? (state.nscope === 'seq' ? '1 sequence = 1 video' : '1 longest layer = 1 clip') : '1 V1 clip = 1 file, under the cap';
    showAc();
  }
  Array.prototype.forEach.call($('mode').children, function (b) {
    b.addEventListener('click', function () {
      if (state.busy || state.mode === b.getAttribute('data-v')) return;
      state.mode = b.getAttribute('data-v');
      try { window.localStorage.setItem('opt:mode', state.mode); } catch (e) {}
      if (state.info) loadOutDir();
      if (state.info) showOutDir();
      refresh();
    });
  });
  Array.prototype.forEach.call($('nscope').children, function (b) {
    b.addEventListener('click', function () {
      if (state.busy || state.nscope === b.getAttribute('data-v')) return;
      state.nscope = b.getAttribute('data-v');
      try { window.localStorage.setItem('opt:nscope', state.nscope); } catch (e) {}
      render();
    });
  });
  $('selall').addEventListener('click', function () {
    if (state.busy) return;
    var allOn = state.plan.every(function (p) { return p.on; });
    state.plan.forEach(function (p) { state.off[p.key] = allOn; }); render();
  });
  $('selactive').addEventListener('click', function () {
    if (state.busy || !state.info) return;
    state.plan.forEach(function (p) { state.off[p.key] = p.seqId !== state.info.activeId; }); render();
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
  var lastFocus = 0;     // one re-read per return to the panel, never while exporting
  window.addEventListener('focus', function () { var t = Date.now(); if (state.busy || t - lastFocus < 1500) return; lastFocus = t; refresh(); });
  refresh();
  var AFTER_HISTORY = function () { refresh(); };

  // ---------------- Undo / Redo (Premiere's own history) ----------------
  // Cmd+Z inside a focused panel goes to the panel, not to Premiere, so the panel forwards it (buttons + keys).
  var histTimer = 0;
  async function history(dir) {
    var r = await evalJsx('uaiHistory(' + JSON.stringify(dir) + ')'), el = $('hmsg');
    var ok = /^OK:/.test(r), moved = ok ? r.slice(3) : '0';
    el.textContent = !ok ? 'Undo not available' : moved === '0' ? 'Nothing to ' + dir : (dir === 'undo' ? 'Undone' : 'Redone');
    el.className = 'hmsg' + (ok && moved !== '0' ? ' on' : '');
    clearTimeout(histTimer); histTimer = setTimeout(function () { el.textContent = ''; el.className = 'hmsg'; }, 2200);
    if (ok && moved !== '0' && typeof AFTER_HISTORY === 'function') AFTER_HISTORY();
  }
  $('hundo').addEventListener('click', function () { history('undo'); });
  $('hredo').addEventListener('click', function () { history('redo'); });
  document.addEventListener('keydown', function (ev) {
    if (!(ev.metaKey || ev.ctrlKey) || String(ev.key).toLowerCase() !== 'z') return;
    var t = ev.target && ev.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;     // text fields keep their own undo
    ev.preventDefault();
    history(ev.shiftKey ? 'redo' : 'undo');
  });

  // ---------------- About: New updates (changelog.json shipped with the panel) ----------------
  (function renderUpdates() {
    var box = $('updates'); if (!box) return;
    var log; try { log = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'changelog.json'), 'utf8')); } catch (e) { box.textContent = 'No update history in this install.'; return; }
    box.innerHTML = '';
    (log.entries || []).forEach(function (e, i) {
      var d = new Date(e.date), card = document.createElement('div');
      card.className = 'upd' + (i === 0 ? ' latest' : '');
      card.innerHTML = '<div class="uh"><b></b><span></span></div>';
      card.querySelector('b').textContent = 'v' + e.version + (i === 0 ? ' · installed' : '');
      card.querySelector('span').textContent = isNaN(d) ? e.date : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      (e.changes || []).forEach(function (c) {
        var row = document.createElement('div'); row.className = 'uc';
        row.innerHTML = '<span class="w"></span><span class="b"></span><span class="a">→</span><span class="n"></span>';
        row.children[0].textContent = c.what; row.children[1].textContent = c.before; row.children[3].textContent = c.now;
        card.appendChild(row);
      });
      box.appendChild(card);
    });
  })();
})();
