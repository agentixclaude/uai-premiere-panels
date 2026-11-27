/* UAI Smart Export — panel logic (1.10.0)
   Export:  Colour grading export = one Media Encoder job per enabled V1 clip, 4K, AC rule (under the cap) or Client rule
            (8K→4K 4.5–4.8 GB ≤200 Mbps, 4K ≤90 Mbps under 2 GB), file named after the clip, 1-frame clean edge.
            Normal export = whole sequence, clips by cuts (cuts.js) or markers named "Clip …"; match source, medium VBR.
   Outputs: Master (the export) + optional Social copy and Review pack, both made from the master after it passes QC.
   QC:      each queued file is watched; when Media Encoder has finished it, qc.js checks frames, loudness, duration,
            codec/size. Results stay with the project.
   Deliver: passed files copied into a Google Drive for desktop folder, QC report, Asana/Slack prompt for Claude.
   Guard:   warns when the saved project's Viewer Gamma is not 1.96 and can set it (save, close, rewrite, reopen). */
(function () {
  var nodeReq = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var fs = nodeReq('fs'), path = nodeReq('path'), os = nodeReq('os'), cp = nodeReq('child_process'), zlib = nodeReq('zlib');
  var EXT_DIR = decodeURI(window.location.pathname).replace(/\/index\.html$/, '');
  var TEMPLATE = path.join(EXT_DIR, 'preset', 'base.epr');
  var APP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'UAI Smart Export');
  var PRESET_DIR = path.join(APP_DIR, 'presets');
  var REPO = 'agentixclaude/uai-premiere-panels';
  var VERSION_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/panel/version.json';
  var ZIP_URL = 'https://codeload.github.com/' + REPO + '/zip/refs/heads/main';
  var https = nodeReq('https');
  var AUDIO_MBPS = 0.32, SAFETY = 0.95, BPP = 0.16;
  var N = window.UAINaming, Q = window.UAIQC, C = window.UAICuts;
  window.addEventListener('error', function (e) {     // show script errors in the panel instead of failing silently
    var el = document.getElementById('status'); if (el) { el.textContent = 'Panel error: ' + e.message + ' (' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ')'; el.className = 'status tone-bad'; }
  });

  var $ = function (id) { return document.getElementById(id); };
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
  var q = function (s) { return JSON.stringify(String(s)); };
  function evalJsx(script) { return new Promise(function (resolve) { window.__adobe_cep__.evalScript(script, function (r) { resolve(r); }); }); }
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) {} return null; }

  // ---------- settings ----------
  var DEF = { capGb: 2, capMbps: 200, rule: 'auto', replace: false, autostart: false,
    tplGrade: '{Clip}', tplNormal: '{Project}_{Sequence}_{Clip}_{Ratio}_v{NN}', neverGrade: false, neverNormal: true,
    autoqc: true, chkFrames: true, chkLoud: true, lufs: -14, chkDur: true, chkCodec: true, notify: true,
    pack720: true, packMB: 16, packSheet: true, packCover: true, guard: true, social: false, review: false,
    upMaster: true, upSocial: true, upReview: true, upReport: true, asanaOn: false, asanaProj: 'Creative Requests', slackOn: false, slackCh: '', driveAcct: '' };
  var cfg = {};
  (function loadCfg() {
    var saved = {}; try { saved = JSON.parse(store('cfg110') || '{}') || {}; } catch (e) {}
    Object.keys(DEF).forEach(function (k) { cfg[k] = k in saved ? saved[k] : DEF[k]; });
    if (!store('cfg110')) {      // carry the 1.9 options over once
      var o = function (k) { return store('opt:' + k); };
      if (o('capgb') !== null) cfg.capGb = parseFloat(o('capgb')) || 2;
      if (o('capmbps') !== null) cfg.capMbps = parseFloat(o('capmbps')) || 200;
      if (o('replace') !== null) cfg.replace = o('replace') === '1';
      if (o('autostart') !== null) cfg.autostart = o('autostart') === '1';
    }
  })();
  function saveCfg() { store('cfg110', JSON.stringify(cfg)); }

  var state = { info: null, ninfo: null, mode: store('opt:mode') === 'normal' ? 'normal' : 'grade',
    scope: 'all', nscope: ({ cuts: 1, marks: 1 })[store('opt:nscope')] ? store('opt:nscope') : 'seq',
    outDir: '', plan: [], busy: false, off: {}, qcItems: [], qcBusy: false, tab: 'export', gammaHidden: {} };

  // ---------- folders ----------
  function findFinalOutput(projectPath) {
    var projDir = path.dirname(projectPath), bases = [path.dirname(projDir), path.dirname(path.dirname(projDir))];
    for (var i = 0; i < bases.length; i++) {
      try {
        var hit = fs.readdirSync(bases[i]).filter(function (n) { return /^final[ _-]?outputs?$/i.test(n); })[0];
        if (hit && fs.statSync(path.join(bases[i], hit)).isDirectory()) return path.join(bases[i], hit);
      } catch (e) {}
    }
    return path.join(path.dirname(projDir), 'Final Output');
  }
  function defaultOutDir(p) {
    var fo = findFinalOutput(p);
    if (state.mode === 'normal' && !fs.existsSync(fo)) return path.join(path.dirname(p), 'Exports');
    return fo;
  }
  function loadOutDir() { var p = state.info.projectPath; state.outDir = store('out:' + p) || defaultOutDir(p); }
  function showOutDir() {
    var el = $('outdir');
    el.textContent = state.outDir ? '‎' + state.outDir + '‎' : 'Open a saved project';
    el.title = state.outDir;
    el.className = 'path' + (state.outDir && fs.existsSync(state.outDir) ? '' : ' missing');
    $('resetdir').hidden = !(state.info && store('out:' + state.info.projectPath));
  }
  function dirFiles(d) { try { return fs.readdirSync(d).filter(function (n) { return /\.mp4$/i.test(n); }); } catch (e) { return []; } }
  function openPath(p, reveal) {
    if (!p) return;
    var target = fs.existsSync(p) ? p : path.dirname(p);
    cp.execFile('/usr/bin/open', reveal && fs.existsSync(p) ? ['-R', p] : [target]);
  }

  // ---------- rules ----------
  function isAcPath(p) { return String(p).split('/').some(function (seg) { return /^AC\s*#?\s*\d+([^0-9]|$)/i.test(seg) || /(^|[^A-Za-z])AC\s*#\s*\d+/i.test(seg); }); }
  function gradeRule() { return cfg.rule === 'auto' ? (state.info && isAcPath(state.info.projectPath) ? 'ac' : 'client') : cfg.rule; }
  function frameFor(w, h) {
    var longSide = Math.max(w, h);
    if (longSide <= 3840) return { w: w, h: h };
    var k = 3840 / longSide, r = function (v) { return Math.round(v * k / 2) * 2; };
    return { w: r(w), h: r(h) };
  }
  // colour-grading bitrate + size band for one clip (srcW/srcH = the sequence frame = the source size class)
  function gradeRate(srcW, srcH, dur) {
    if (gradeRule() === 'ac') return { mbps: Math.max(1, Math.min(cfg.capMbps, Math.floor(cfg.capGb * SAFETY * 8000 / dur - AUDIO_MBPS))), band: { maxGb: cfg.capGb }, rule: 'AC' };
    if (Math.max(srcW, srcH) > 3840) return { mbps: Math.max(1, Math.min(200, Math.floor(4.65 * 8000 / dur - AUDIO_MBPS))), band: { minGb: 4.5, maxGb: 4.8 }, rule: '8K→4K' };
    return { mbps: Math.max(1, Math.min(90, Math.floor(2 * SAFETY * 8000 / dur - AUDIO_MBPS))), band: { maxGb: 2 }, rule: '4K' };
  }

  // ---------- plan ----------
  function tpl() { return state.mode === 'normal' ? cfg.tplNormal : cfg.tplGrade; }
  function never() { return state.mode === 'normal' ? cfg.neverNormal : cfg.neverGrade; }
  function projName() { return state.info ? state.info.projectName.replace(/\.prproj$/i, '') : ''; }
  function buildPlan() {
    if (!state.info) return [];
    var plan = [], taken = {}, files = dirFiles(state.outDir), proj = projName();
    var nameFor = function (seqName, clip, w, h) {
      return N.pick(tpl(), { project: proj, sequence: seqName, clip: clip, ratio: N.ratio(w, h) }, files, taken, { never: never() });
    };
    var finish = function (p, nm) {
      p.stem = nm.stem; p.out = path.join(state.outDir, nm.stem + '.mp4');
      p.exists = fs.existsSync(p.out); p.prev = nm.prev ? path.join(state.outDir, nm.prev + '.mp4') : '';
      p.version = nm.version; plan.push(p);
    };
    if (state.mode === 'grade') {
      state.info.sequences.forEach(function (s) {
        if (state.scope === 'active' && s.id !== state.info.activeId) return;
        var f = frameFor(s.w, s.h), fps = C.TICKS / Number(s.timebase);
        s.clips.forEach(function (c) {
          if (!c.enabled || (state.scope === 'selected' && !c.selected)) return;
          var dur = c.end - c.start; if (dur <= 0) return;
          var r = gradeRate(s.w, s.h, dur), edge = dur > 10 / fps ? 1 / fps : 0;
          finish({ key: s.id + '|' + c.start, on: true, seqId: s.id, seqName: s.name, start: c.start, end: c.end, dur: dur,
            expectDur: dur - 2 * edge, seqStart: c.start + edge, fps: fps, srcIn: c.inPoint, srcOut: c.outPoint, mbps: r.mbps, band: r.band, rule: r.rule,
            w: f.w, h: f.h, gb: (r.mbps + AUDIO_MBPS) * dur / 8000, markers: s.markers || [], sub: r.rule + ' · ' + r.mbps + ' Mbps' },
            nameFor(s.name, c.name, f.w, f.h));
        });
      });
      return plan;
    }
    if (!state.ninfo) return plan;
    var nestedNames = {};
    state.ninfo.sequences.forEach(function (s) { (s.nested || []).forEach(function (n) { nestedNames[n] = true; }); });
    state.ninfo.sequences.forEach(function (s) {
      if (!s.items || !s.items.length) return;
      var tb = Number(s.timebase), fps = C.TICKS / tb, f = frameFor(s.w, s.h);
      var mbps = Math.max(6, Math.min(60, Math.round(f.w * f.h * fps * BPP / 1e6))), nested = !!nestedNames[s.name];
      var add = function (clipName, inF, outF, dur, key, sub) {
        finish({ normal: true, key: key, on: !(key in state.off ? state.off[key] : nested), nested: nested, sub: sub,
          seqId: s.id, seqName: s.name, inF: inF, outF: outF, dur: dur, expectDur: dur, seqStart: inF < 0 ? 0 : inF / fps,
          fpsTicks: tb, fps: fps, mbps: mbps, maxMbps: Math.round(mbps * 1.3), w: f.w, h: f.h, gb: (mbps + AUDIO_MBPS) * dur / 8000,
          band: null, markers: s.markers || [] }, nameFor(s.name, clipName, f.w, f.h));
      };
      if (state.nscope === 'seq') {
        var endT = Number(s.end);
        if (!(endT > 0)) endT = Math.max.apply(null, s.items.map(function (it) { return Number(it.e); }));
        var dur = endT / C.TICKS; if (!(dur > 0)) return;
        add('', -1, -1, dur, s.id, 'whole timeline');
      } else if (state.nscope === 'cuts') {
        C.detect(s).forEach(function (c) {
          add('Clip' + (c.label < 10 ? '0' : '') + c.label, c.a, c.b, (c.b - c.a) / fps, s.id + ':' + c.a + '-' + c.b,
              'longest: ' + c.layer + ' (' + c.track + ') · ' + c.layers + ' layers');
        });
      } else {
        C.detectMarkers(s).forEach(function (m) {
          add(N.camel(m.name), m.a, m.b, (m.b - m.a) / fps, s.id + ':m' + m.a, 'marker “' + m.name + '”');
        });
      }
    });
    return plan;
  }
  function fmtDur(s) { var m = Math.floor(s / 60), r = Math.round(s - m * 60); if (r === 60) { m++; r = 0; } return m + ':' + (r < 10 ? '0' : '') + r; }
  function fmtFrames(fr, fps) { var s = fr / fps, h = Math.floor(s / 3600); return (h ? h + ':' + (Math.floor(s / 60) % 60 < 10 ? '0' : '') : '') + fmtDur(h ? s - h * 3600 : s); }
  function selected() { return state.plan.filter(function (p) { return p.on !== false; }); }
  function outputsPer() { return 1 + (cfg.social ? 1 : 0) + (cfg.review ? 1 : 0); }

  // ---------- render: Export ----------
  function chipFor(p) {
    if (p.exists) return { t: cfg.replace ? 'replace' : 'exists', c: 'warn' };
    if (p.version > 1) return { t: 'v' + (p.version < 10 ? '0' : '') + p.version, c: 'accent' };
    return { t: p.on === false ? 'off' : 'ready', c: '' };
  }
  function render() {
    state.plan = buildPlan();
    syncMode();
    var list = $('list'), lastSeq = null, total = 0, maxGb = 0, normal = state.mode === 'normal';
    list.innerHTML = '';
    state.plan.forEach(function (p, i) {
      if (p.seqId !== lastSeq) {
        var head = document.createElement('div'); head.className = 'head' + (normal ? ' sel' : '');
        if (normal) {
          head.innerHTML = '<label><input type="checkbox"><span></span></label><span class="muted"></span>';
          head.querySelector('label span').textContent = p.seqName + (p.nested ? ' · nested' : '');
          var kids = state.plan.filter(function (x) { return x.seqId === p.seqId; }), hb = head.querySelector('input');
          hb.checked = kids.every(function (x) { return x.on; }); hb.indeterminate = !hb.checked && kids.some(function (x) { return x.on; });
          hb.disabled = state.busy;
          hb.addEventListener('change', function () { if (state.busy) return; kids.forEach(function (x) { state.off[x.key] = !hb.checked; }); render(); });
          head.children[1].textContent = p.w + '×' + p.h + ' · ' + (Math.round(p.fps * 100) / 100) + ' fps · ' + p.mbps + ' Mbps';
        } else {
          head.innerHTML = '<span></span><span class="muted"></span>';
          head.children[0].textContent = p.seqName; head.children[1].textContent = p.w + '×' + p.h + ' · ' + p.rule;
        }
        list.appendChild(head); lastSeq = p.seqId;
      }
      var row = document.createElement(normal ? 'label' : 'div'); row.id = 'clip' + i;
      row.className = 'clip' + (normal ? ' sel' + (p.on ? '' : ' off') : '');
      row.innerHTML = (normal ? '<input type="checkbox">' : '') + '<span class="n"></span><span class="t"></span><span class="chip"></span>';
      var k = normal ? 1 : 0;
      if (normal) {
        var cb = row.children[0]; cb.checked = p.on; cb.disabled = state.busy;
        cb.addEventListener('change', function () { if (state.busy) return; state.off[p.key] = !cb.checked; render(); });
      }
      row.children[k].textContent = p.stem;
      if (normal) row.children[k + 1].textContent = p.inF < 0 ? fmtDur(p.dur) : fmtFrames(p.inF, p.fps) + ' → ' + fmtFrames(p.outF, p.fps);
      else { var a = isFinite(p.srcIn) ? p.srcIn : p.start, b = isFinite(p.srcOut) ? p.srcOut : p.end; row.children[k + 1].textContent = fmtDur(a) + ' → ' + fmtDur(b); }
      row.title = p.stem + '.mp4 · ' + (p.sub || '') + ' · ' + fmtDur(p.dur) + ' · ' + p.mbps + ' Mbps · ≈' + p.gb.toFixed(2) + ' GB';
      var ch = chipFor(p), chip = row.children[k + 2]; chip.textContent = ch.t; chip.className = 'chip ' + ch.c;
      list.appendChild(row);
      if (p.on !== false) { total += p.dur; maxGb = Math.max(maxGb, p.gb); }
    });
    if (!state.plan.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = !state.info ? 'Open a saved project.' : normal
        ? (!state.ninfo ? 'Reading sequences…' : state.nscope === 'cuts' ? 'No clips found: the sequences are empty.' : state.nscope === 'marks' ? 'No sequence markers named “Clip …”. Add markers named Clip 1, Clip 2… (or one marker with a duration per clip).' : 'No sequence has anything on its tracks.')
        : state.scope === 'selected' ? 'Select clips in the timeline, then press Refresh.' : 'No enabled clips on V1.';
      list.appendChild(e);
    }
    var n = selected().length, unit = normal && state.nscope === 'seq' ? ['video', 'videos'] : ['clip', 'clips'];
    $('count').textContent = normal ? n + ' of ' + state.plan.length + ' ' + (state.plan.length === 1 ? unit[0] : unit[1]) : n + ' ' + (n === 1 ? unit[0] : unit[1]);
    $('summary').textContent = !n ? '' : normal ? fmtDur(total) + ' total' : 'largest ≈ ' + maxGb.toFixed(2) + ' GB';
    var per = outputsPer();
    $('go').textContent = (!normal && state.scope === 'all' ? 'Export all (' + n + ')' : 'Export ' + n) + (per > 1 ? ' × ' + per + ' outputs' : '');
    $('go').disabled = !n || state.busy;
    renderOutline();
  }
  function renderOutline() {
    var normal = state.mode === 'normal', first = selected()[0];
    var preview = first ? first.stem : N.pick(tpl(), { project: projName() || 'Project', sequence: 'Sequence', clip: normal ? 'Clip01' : 'CAM1-0001', ratio: '9x16' }, [], {}, {}).stem;
    var rule = normal ? 'match source · medium' : (gradeRule() === 'ac' ? 'AC · under ' + cfg.capGb + ' GB' : 'Client · 8K→4K 4.5–4.8 GB · 4K <2 GB');
    var el = $('outlinetext'); el.innerHTML = '';
    el.appendChild(document.createTextNode('H.264 · ' + rule + (cfg.autoqc ? ' · Auto QC' : '') + ' · '));
    var b = document.createElement('b'); b.textContent = preview; el.appendChild(b);
    $('out-social').className = 'chip' + (cfg.social ? ' accent' : ''); $('out-social').textContent = (cfg.social ? '✓ ' : '+ ') + 'Social';
    $('out-review').className = 'chip' + (cfg.review ? ' accent' : ''); $('out-review').textContent = (cfg.review ? '✓ ' : '+ ') + 'Review pack';
  }
  var TONE = { queued: 'ok', ok: 'ok', skipped: 'warn', failed: 'bad', '': 'busy' };
  function setRow(i, cls, text) {
    var row = $('clip' + i); if (!row) return;
    var chip = row.querySelector('.chip');
    row.className = 'clip ' + (row.querySelector('input') ? 'sel ' : '') + cls; chip.textContent = text; chip.className = 'chip ' + (TONE[cls] || '');
    row.scrollIntoView({ block: 'nearest' });
  }
  function syncMode() {
    var normal = state.mode === 'normal';
    $('mode').value = state.mode; $('scope').value = state.scope; $('nscope').value = state.nscope;
    $('scope').hidden = normal; $('nscope').hidden = !normal;
    $('selall').hidden = !normal; $('selactive').hidden = !normal;
    showChip();
  }
  function showChip() {
    var chip = $('acchip'); if (!state.info) { chip.hidden = true; return; }
    chip.hidden = false;
    if (state.mode === 'normal') { chip.textContent = 'Normal'; chip.className = 'chip'; chip.title = 'Normal export: match source, medium bitrate, no size cap'; return; }
    var r = gradeRule();
    chip.textContent = r === 'ac' ? 'AC client' : 'Client'; chip.className = 'chip' + (r === 'ac' ? ' accent' : '');
    chip.title = r === 'ac' ? 'AC rule: 4K, every file under ' + cfg.capGb + ' GB' : 'Client rule: 8K→4K 4.5–4.8 GB (≤200 Mbps), 4K ≤90 Mbps under 2 GB';
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
    if (p.h > 2304 || p.w > 4096) x = setParam(x, 'ADBEVideoMPEGProfileLevel', 62);
    x = setParam(x, 'ADBEVideoTargetBitrate', p.mbps + '.');
    if (p.normal) {
      x = setParam(x, 'ADBEVideoMaxBitrate', p.maxMbps + '.');
      x = setParam(x, 'ADBEVideoBitrateEncoding', 1);
      x = setParam(x, 'ADBEVideoFPS', p.fpsTicks);
    } else x = setParam(x, 'ADBEVideoMaxBitrate', Math.min(300, Math.round(p.mbps * 1.2)) + '.');
    x = x.replace(/<PresetName>[^<]*<\/PresetName>/, '<PresetName>UAI ' + (p.normal ? 'Normal Export ' : 'Smart Export ') + p.w + 'x' + p.h + ' ' + p.mbps + 'Mbps</PresetName>');
    x = x.replace(/<PresetID>[^<]*<\/PresetID>/, '<PresetID>' + uuid() + '</PresetID>');
    var file = path.join(PRESET_DIR, (p.normal ? 'N_' + Math.round(p.fps * 1000) + '_' : '') + p.w + 'x' + p.h + '_' + p.mbps + 'Mbps.epr');
    fs.writeFileSync(file, x, 'utf8');
    return file;
  }

  // ---------- run ----------
  function status(id, t, tone) { var el = $(id); el.textContent = t; el.className = 'status' + (tone ? ' tone-' + tone : ''); }
  async function refresh() {
    if (state.busy) return;
    var raw = await evalJsx('ugInfo()'), info = null;
    try { info = JSON.parse(raw); } catch (e) { info = { error: 'Premiere did not answer. Reopen the panel.' }; }
    if (info.error) { state.info = null; $('project').textContent = info.error; state.outDir = ''; showOutDir(); showChip(); render(); renderQC(); checkGamma(); return; }
    var changed = !state.info || state.info.projectPath !== info.projectPath;
    state.info = info;
    if (changed) { state.off = {}; loadQC(); }
    if (state.mode === 'normal') {
      var ni = null; try { ni = JSON.parse(await evalJsx('ugNormalInfo()')); } catch (e) { ni = null; }
      state.ninfo = ni && !ni.error ? ni : null;
      if (ni && ni.error) status('status', ni.error, 'bad');
    }
    $('project').textContent = projName();
    if (changed) { loadOutDir(); loadDeliver(); checkGamma(); }
    showOutDir(); render(); renderQC();
  }
  async function run() {
    if (state.busy || !state.plan.length) return;
    var plan = state.plan.slice(), done = 0, skipped = 0, failed = 0, saved = {}, todo = selected().length, k = 0, queued = [];
    state.busy = true; $('go').disabled = true;
    try {
      fs.mkdirSync(state.outDir, { recursive: true }); showOutDir();
      for (var i = 0; i < plan.length; i++) {
        var p = plan[i];
        if (p.on === false) continue;
        k++;
        if (fs.existsSync(p.out)) {
          if (!cfg.replace) { skipped++; setRow(i, 'skipped', 'exists'); continue; }
          fs.unlinkSync(p.out);
        }
        status('status', 'Queuing ' + k + ' of ' + todo + ' — ' + p.stem);
        setRow(i, '', '…');
        if (!(p.seqId in saved) && !(p.normal && p.inF < 0)) saved[p.seqId] = await evalJsx('ugGetInOut(' + q(p.seqId) + ')');
        var preset = makePreset(p);
        var r = p.normal
          ? await evalJsx('ugQueueFrames(' + q(p.seqId) + ',' + p.inF + ',' + p.outF + ',' + q(p.out) + ',' + q(preset) + ')')
          : await evalJsx('ugQueue(' + q(p.seqId) + ',' + p.start + ',' + p.end + ',' + q(p.out) + ',' + q(preset) + ')');
        if (/^OK:/.test(r)) { done++; setRow(i, 'queued', 'queued'); queued.push(p); }
        else { failed++; setRow(i, 'failed', 'failed'); console.error(p.stem, r); state.lastError = r; }
      }
      for (var id in saved) {
        var io = String(saved[id]).split('|');
        if (io.length === 2 && isFinite(parseFloat(io[0])) && isFinite(parseFloat(io[1])))
          await evalJsx('ugSetInOut(' + q(id) + ',' + parseFloat(io[0]) + ',' + parseFloat(io[1]) + ')');
      }
      if (done && cfg.autostart) await evalJsx('ugStartQueue()');
      if (queued.length) addQC(queued, true);
      status('status', done + ' queued' + (skipped ? ', ' + skipped + ' skipped (file exists)' : '') + (failed ? ', ' + failed + ' failed: ' + String(state.lastError).replace(/^ERR:/, '') : '')
             + (done ? (cfg.autostart ? ' — encoding started.' : ' — press Start Queue in Media Encoder.') + (cfg.autoqc ? ' QC checks each file when it is done.' : '') : ''), failed ? 'bad' : done ? 'ok' : 'warn');
    } catch (e) { status('status', 'Stopped: ' + e.message, 'bad'); }
    state.busy = false; render();
  }

  // ---------- QC ----------
  function qcKey() { return state.info ? 'qc:' + state.info.projectPath : ''; }
  function loadQC() {
    state.qcItems = []; try { state.qcItems = JSON.parse(store(qcKey()) || '[]') || []; } catch (e) {}
    state.qcItems.forEach(function (it) { if (it.state === 'checking' || it.state === 'queued') it.state = it.res ? 'checked' : 'rendered'; it.opened = false; });
    watchStart();
  }
  function saveQC() { if (qcKey()) store(qcKey(), JSON.stringify(state.qcItems.slice(-300))); }
  function itemFrom(p, file, watching) {
    return { key: file, file: file, stem: path.basename(file, '.mp4'), seqId: p.seqId, seqName: p.seqName, seqStart: p.seqStart, w: p.w, h: p.h, fps: p.fps,
             expectDur: p.expectDur, band: p.band, normal: !!p.normal, markers: p.markers || [], state: watching ? 'rendering' : 'rendered', res: null, derived: {}, opened: false, sizes: [] };
  }
  function addQC(plan, watching) {
    plan.forEach(function (p) {
      var it = itemFrom(p, p.out, watching), old = state.qcItems.filter(function (x) { return x.key === it.key; })[0];
      if (old) state.qcItems.splice(state.qcItems.indexOf(old), 1);
      state.qcItems.push(it);
    });
    saveQC(); renderQC(); if (watching) watchStart();
  }
  var watchTimer = 0;
  function watchStart() { if (!watchTimer && state.qcItems.some(function (x) { return x.state === 'rendering'; })) watchTimer = setInterval(watchTick, 4000); }
  var ticking = false;
  async function watchTick() {
    if (ticking) return; ticking = true;
    var waiting = state.qcItems.filter(function (x) { return x.state === 'rendering'; });
    if (!waiting.length) { clearInterval(watchTimer); watchTimer = 0; ticking = false; return; }
    for (var i = 0; i < waiting.length; i++) {
      var it = waiting[i], st = null;
      try { st = fs.statSync(it.file); } catch (e) { continue; }
      it.sizes = (it.sizes || []).concat([st.size]).slice(-3);
      if (st.size > 0 && it.sizes.length === 3 && it.sizes[0] === it.sizes[2] && Date.now() - st.mtimeMs > 6000) {
        var pr = await Q.probe(it.file);
        if (!pr.error && pr.dur > 0) { it.state = 'rendered'; saveQC(); if (cfg.autoqc) qcQueue([it]); else renderQC(); }
      }
    }
    ticking = false;
  }
  var qcPending = [];
  function qcCfg(it) { return { chkFrames: cfg.chkFrames, chkLoud: cfg.chkLoud, lufs: cfg.lufs, chkDur: cfg.chkDur, chkCodec: cfg.chkCodec, loudInfo: !it.normal }; }
  function qcQueue(items) {
    items.forEach(function (it) { if (qcPending.indexOf(it) < 0) { it.state = 'queued'; qcPending.push(it); } });
    renderQC(); if (!state.qcBusy) qcLoop();
  }
  async function qcLoop() {
    state.qcBusy = true; $('qrun').disabled = true;
    var ran = 0;
    while (qcPending.length) {
      var it = qcPending.shift();
      if (!fs.existsSync(it.file)) { it.state = 'missing'; it.res = null; renderQC(); continue; }
      it.state = 'checking'; renderQC();
      status('qstatus', 'Checking ' + it.stem + '…');
      try { it.res = await Q.check(it.file, it, qcCfg(it)); } catch (e) { it.res = { error: e.message, checks: {}, pass: false, at: Date.now() }; }
      it.state = 'checked'; ran++;
      if (it.res.pass && (cfg.social || cfg.review)) { try { await derive(it); } catch (e) { console.error(e); } }
      saveQC(); renderQC();
    }
    state.qcBusy = false; $('qrun').disabled = false;
    var c = qcCounts();
    status('qstatus', ran ? c.pass + ' passed, ' + c.fix + ' to fix' + (c.missing ? ', ' + c.missing + ' not found' : '') + (c.wait ? ', ' + c.wait + ' still rendering' : '') + '.' : '', c.fix ? 'bad' : 'ok');
    if (ran && cfg.notify && !c.wait) Q.notify('UAI Smart Export · QC done', c.pass + ' passed, ' + c.fix + ' to fix — ' + projName());
    renderDeliver();
  }
  async function derive(it) {
    it.derived = it.derived || {};
    var info = it.res.info, dir = path.dirname(it.file);
    if (cfg.social && !(it.derived.social && fs.existsSync(it.derived.social))) {
      status('qstatus', 'Making the Social copy of ' + it.stem + '…');
      it.derived.social = await Q.social(it.file, info, path.join(dir, 'Social'), it.stem, cfg);
    }
    var rv = it.derived.review || {}, have = function (k) { return rv[k] && fs.existsSync(rv[k]); };
    if (cfg.review && !((!cfg.pack720 || have('review')) && (!cfg.packSheet || have('sheet')) && (!cfg.packCover || have('cover')))) {
      status('qstatus', 'Making the review pack of ' + it.stem + '…');
      var coverAt = 0;
      (it.markers || []).forEach(function (m) { if (/^cover$/i.test(String(m.n).trim())) { var t = Number(m.s) / C.TICKS - (it.seqStart || 0); if (t >= 0 && t < info.dur && !coverAt) coverAt = t; } });
      it.derived.review = await Q.reviewPack(it.file, info, path.join(dir, 'Review'), it.stem, cfg, coverAt);
    }
  }
  function qcCounts() {
    var c = { pass: 0, fix: 0, wait: 0, missing: 0 };
    state.qcItems.forEach(function (it) {
      if (it.state === 'rendering' || it.state === 'queued' || it.state === 'checking') c.wait++;
      else if (it.state === 'missing') c.missing++;
      else if (it.res) { if (it.res.pass) c.pass++; else c.fix++; }
    });
    return c;
  }
  function checkAll() {
    if (!state.info) { showTab('qc'); status('qstatus', 'Open a saved project first.', 'warn'); return; }
    showTab('qc');
    if (!state.qcItems.length) {      // nothing exported from this panel yet: check the files listed on Export
      state.qcItems = selected().map(function (p) { var f = p.version > 0 ? p.prev : p.out; return f ? itemFrom(p, f, false) : null; }).filter(Boolean);
      saveQC();
    }
    if (!state.qcItems.length) { status('qstatus', 'Nothing to check: no files listed on Export.', 'warn'); renderQC(); return; }
    qcQueue(state.qcItems.filter(function (it) { return it.state !== 'rendering'; }));
  }
  function dotCls(c) { return !c ? 'off' : c.ok === true ? 'ok' : c.ok === false ? 'bad' : c.ok === 'warn' ? 'warn' : 'off'; }
  function renderQC() {
    var box = $('qlist'), c = qcCounts();
    $('qpass').textContent = c.pass; $('qfix').textContent = c.fix; $('qfix').className = c.fix ? 'tone-bad' : '';
    var last = state.qcItems.reduce(function (m, it) { return Math.max(m, it.res ? it.res.at || 0 : 0); }, 0);
    $('qwhen').textContent = c.wait ? c.wait : last ? new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    $('qwhenl').textContent = c.wait ? 'rendering / in check' : last ? 'last check' : 'not checked';
    var badge = $('qcbadge'); badge.hidden = !(c.fix || c.wait); badge.textContent = c.fix || c.wait; badge.className = 'badge' + (c.fix ? '' : ' ok');
    if (!state.qcItems.length) { box.innerHTML = '<div class="empty">Export, then each file is checked here when Media Encoder finishes. Or press Check all.</div>'; renderDeliver(); return; }
    box.innerHTML = '';
    state.qcItems.forEach(function (it) {
      var wrap = document.createElement('div'); wrap.className = 'qwrap';
      var btn = document.createElement('button'), r = it.res, ck = r ? r.checks || {} : {};
      var tag = it.state === 'rendering' ? ['rendering', 'busy'] : it.state === 'queued' ? ['waiting', 'busy'] : it.state === 'checking' ? ['checking', 'busy'] : it.state === 'missing' ? ['missing', 'warn'] : r ? (r.pass ? (r.warn ? ['check', 'warn'] : ['passed', 'ok']) : ['fix', 'bad']) : ['not checked', ''];
      btn.className = 'qrow' + (r && !r.pass ? ' bad' : '');
      btn.innerHTML = '<span class="n"></span><span class="dots"><i class="dot"></i><i class="dot"></i><i class="dot"></i><i class="dot"></i></span><span class="chip"></span>';
      btn.children[0].textContent = it.stem;
      if (r && r.info) { var sm = document.createElement('small'); sm.textContent = fmtDur(r.info.dur) + ' · ' + (r.info.bytes >= 1e9 ? (r.info.bytes / 1e9).toFixed(2) + ' GB' : Math.round(r.info.bytes / 1e6) + ' MB'); btn.children[0].appendChild(sm); }
      ['frames', 'loud', 'dur', 'codec'].forEach(function (k, j) { btn.children[1].children[j].className = 'dot ' + (it.state === 'checking' ? 'run' : dotCls(ck[k])); });
      btn.children[2].textContent = tag[0]; btn.children[2].className = 'chip ' + tag[1];
      btn.addEventListener('click', function () { it.opened = !it.opened; renderQC(); });
      wrap.appendChild(btn);
      if (it.opened) wrap.appendChild(qcDetail(it));
      box.appendChild(wrap);
    });
    renderDeliver();
  }
  function qcDetail(it) {
    var d = document.createElement('div'), r = it.res, ck = r ? r.checks || {} : {};
    d.className = 'qdet';
    var line = function (k, v, cls) { var x = document.createElement('div'); x.className = 'ck'; x.innerHTML = '<span></span><span></span>'; x.children[0].textContent = k; x.children[1].textContent = v; if (cls) x.children[1].className = cls; d.appendChild(x); };
    if (!r) line('Status', it.state === 'rendering' ? 'waiting for Media Encoder to finish the file' : it.state === 'missing' ? 'file not found: ' + it.file : 'not checked yet');
    else {
      if (r.error) line('File', r.error, 'bad');
      [['frames', 'Start / end'], ['loud', 'Loudness'], ['dur', 'Duration'], ['codec', 'Codec · size']].forEach(function (k) { if (ck[k[0]]) line(k[1], ck[k[0]].txt, ck[k[0]].ok === true ? 'ok' : ck[k[0]].ok === false ? 'bad' : ck[k[0]].ok === 'warn' ? 'warn' : ''); });
    }
    var der = it.derived || {}, rv = der.review || {};
    if (rv.sheet && fs.existsSync(rv.sheet)) { var th = document.createElement('div'); th.className = 'thumbs'; var img = document.createElement('img'); img.src = 'file://' + rv.sheet.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now(); th.appendChild(img); d.appendChild(th); }
    var got = []; if (der.social) got.push('Social'); if (rv.review) got.push('Review 720p'); if (rv.sheet) got.push('Contact sheet'); if (rv.cover) got.push('Cover PNG');
    if (got.length) line('Made', got.join(' · '), 'ok');
    var row = document.createElement('div'); row.className = 'row';
    var mk = function (label, fn, cls) { var b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); }); row.appendChild(b); return b; };
    if (r && (!r.pass || r.warn) && it.seqId) mk('Go to problem', async function () {
      var at = (it.seqStart || 0) + (r.problemAt !== null && r.problemAt !== undefined ? r.problemAt : 0);
      var res = await evalJsx('ugGotoSeq(' + q(it.seqId) + ',' + at + ')');
      status('qstatus', /^OK/.test(res) ? 'Playhead at ' + fmtDur(at) + ' in ' + it.seqName + '.' : 'Could not open the sequence: ' + String(res).replace(/^ERR:/, ''), /^OK/.test(res) ? 'ok' : 'bad');
    }, 'danger');
    var exists = fs.existsSync(it.file);
    mk('Play', function () { openPath(it.file); }).disabled = !exists;
    mk('Show in Finder', function () { openPath(it.file, true); });
    mk('Re-check', function () { it.derived = {}; qcQueue([it]); }).disabled = state.qcBusy && it.state !== 'checked';
    if (!rv.sheet && exists) mk('Frames', async function (b) {
      b.disabled = true; b.textContent = 'Making…';
      var info = r && r.info ? r.info : await Q.probe(it.file);
      var pack = await Q.reviewPack(it.file, info, path.join(path.dirname(it.file), 'Review'), it.stem, { pack720: false, packSheet: true, packCover: false }, 0);
      it.derived = it.derived || {}; it.derived.review = Object.assign({}, it.derived.review || {}, pack); saveQC(); renderQC();
    });
    mk('Remove', function () { state.qcItems.splice(state.qcItems.indexOf(it), 1); saveQC(); renderQC(); }, 'ghost');
    d.appendChild(row);
    return d;
  }

  // ---------- Deliver ----------
  function driveAccounts() {
    var base = path.join(os.homedir(), 'Library', 'CloudStorage'), dirs = [];
    try { dirs = fs.readdirSync(base).filter(function (n) { return /^GoogleDrive-/.test(n); }); } catch (e) {}
    return dirs.map(function (n) {
      var my = fs.existsSync(path.join(base, n, 'My Drive')) ? path.join(base, n, 'My Drive') : path.join(base, n);
      return { root: my, account: n.replace(/^GoogleDrive-/, '') };
    });
  }
  var drives = [], drive = null;
  function loadDeliver() {
    drives = driveAccounts();
    drive = drives.filter(function (d) { return d.account === cfg.driveAcct; })[0] || drives[0] || null;
    var sel = $('driveacctsel'); sel.innerHTML = '';
    drives.forEach(function (d) { var o = document.createElement('option'); o.value = d.account; o.textContent = d.account; sel.appendChild(o); });
    if (!drives.length) { var o = document.createElement('option'); o.textContent = 'Drive for desktop not found'; sel.appendChild(o); }
    sel.disabled = !drives.length; if (drive) sel.value = drive.account;
    var saved = state.info ? store('drive:' + state.info.projectPath) : null;
    state.driveDir = saved || (drive ? path.join(drive.root, 'UAI Deliveries', projName() || 'Export') : '');
    $('asana-task').value = state.info ? store('task:' + state.info.projectPath) || '' : '';
    renderDeliver();
  }
  function outgoing() {
    var files = [], held = [];
    state.qcItems.forEach(function (it) {
      if (!it.res || !it.res.pass) { if (it.res || it.state === 'missing') held.push(it); return; }
      if (cfg.upMaster && fs.existsSync(it.file)) files.push({ it: it, f: it.file, kind: 'Master' });
      var d = it.derived || {};
      if (cfg.upSocial && d.social && fs.existsSync(d.social)) files.push({ it: it, f: d.social, kind: 'Social', sub: 'Social' });
      if (cfg.upReview && d.review) ['review', 'sheet', 'cover'].forEach(function (k) { if (d.review[k] && fs.existsSync(d.review[k])) files.push({ it: it, f: d.review[k], kind: 'Review', sub: 'Review' }); });
    });
    return { files: files, held: held, passed: state.qcItems.filter(function (it) { return it.res && it.res.pass; }) };
  }
  function driveLabel(p) { return p && drive && p.indexOf(drive.root) === 0 ? 'Drive' + p.slice(drive.root.length) : p; }
  var armed = 0;
  function renderDeliver() {
    var o = outgoing(), box = $('dlist');
    $('dpass').textContent = o.passed.length + ' passed QC';
    $('dheld').hidden = !o.held.length; $('dheld').textContent = o.held.length + ' held · needs fix';
    $('driveacct').textContent = drive ? 'Drive for desktop' : 'any folder';
    $('drivedir').textContent = state.driveDir ? '‎' + driveLabel(state.driveDir) + '‎' : '—';
    $('drivedir').title = state.driveDir || '';
    $('drivenote').textContent = drive ? 'Copied into the Drive folder on this Mac; Drive for desktop uploads it.' : 'Google Drive for desktop is not set up on this Mac: choose any folder, or install Drive for desktop and sign in.';
    $('asanasum').textContent = cfg.asanaOn ? 'QC 1 · ' + (cfg.asanaProj || 'Creative Requests') : 'off';
    $('slacksum').textContent = cfg.slackOn ? (cfg.slackCh || 'channel not chosen') : 'off';
    var n = o.files.length + (cfg.upReport && o.passed.length ? 1 : 0), bytes = o.files.reduce(function (s, x) { try { return s + fs.statSync(x.f).size; } catch (e) { return s; } }, 0);
    $('dcount').textContent = n ? n + ' files · ' + (bytes / 1e9).toFixed(2) + ' GB' : '';
    box.innerHTML = '';
    if (!o.files.length && !o.held.length) box.innerHTML = '<div class="empty">Run QC first: only files that pass go out.</div>';
    o.files.forEach(function (x) { var r = document.createElement('div'); r.className = 'drow'; r.innerHTML = '<span class="n"></span><span class="chip ok"></span>'; r.children[0].textContent = path.basename(x.f); r.children[1].textContent = x.kind; box.appendChild(r); });
    if (cfg.upReport && o.passed.length) { var rr = document.createElement('div'); rr.className = 'drow'; rr.innerHTML = '<span class="n">QC report (.md)</span><span class="chip ok">Report</span>'; box.appendChild(rr); }
    o.held.forEach(function (it) { var r = document.createElement('div'); r.className = 'drow held'; r.innerHTML = '<span class="n"></span><span class="chip bad">held</span>'; r.children[0].textContent = it.stem + '.mp4'; box.appendChild(r); });
    var steps = []; if (n && state.driveDir) steps.push('copy ' + n + ' files'); if (cfg.asanaOn) steps.push('Asana'); if (cfg.slackOn) steps.push('Slack');
    if (!armed) $('handoff').textContent = steps.length ? 'Hand off: ' + steps.join(' + ') : 'Hand off';
    $('handoff').disabled = !!state.handing || !o.passed.length || !(n && state.driveDir || cfg.asanaOn || cfg.slackOn);
  }
  function qcReport(o) {
    var lines = ['# QC report — ' + projName(), '', 'Checked by UAI Smart Export ' + localVersion() + ' · ' + new Date().toLocaleString(), '',
      '| File | Result | Start / end | Loudness | Duration | Codec · size |', '|---|---|---|---|---|---|'];
    state.qcItems.forEach(function (it) {
      if (!it.res) return;
      var c = it.res.checks || {}, t = function (k) { return c[k] ? String(c[k].txt).replace(/\|/g, '/') : ''; };
      lines.push('| ' + it.stem + '.mp4 | ' + (it.res.pass ? 'passed' : 'FIX') + ' | ' + t('frames') + ' | ' + t('loud') + ' | ' + t('dur') + ' | ' + t('codec') + ' |');
    });
    lines.push('', o.passed.length + ' passed · ' + o.held.length + ' held');
    return lines.join('\n');
  }
  function pbcopy(text) { return new Promise(function (res) { try { var p = cp.spawn('/usr/bin/pbcopy', [], { env: Object.assign({}, process.env, { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }) }); p.on('error', function () { res(); }); p.on('close', function () { res(); }); p.stdin.on('error', function () {}); p.stdin.end(text); } catch (e) { res(); } }); }
  function copyFile(a, b) { return new Promise(function (res, rej) { fs.copyFile(a, b, function (e) { if (e) rej(e); else res(); }); }); }
  async function handoff() {
    if (state.handing) return;
    var o = outgoing(), n = o.files.length + (cfg.upReport && o.passed.length ? 1 : 0);
    if (!armed) {
      armed = setTimeout(function () { armed = 0; renderDeliver(); status('dstatus', 'Not confirmed: nothing was copied.'); }, 8000);
      $('handoff').textContent = 'Confirm hand off';
      status('dstatus', 'Will ' + [n && state.driveDir ? 'copy ' + n + ' files to ' + driveLabel(state.driveDir) : '', cfg.asanaOn || cfg.slackOn ? 'copy a hand-off prompt for Claude (Asana' + (cfg.slackOn ? ' + Slack draft' : '') + ', you confirm there)' : ''].filter(Boolean).join(', then ') + '. ' + o.held.length + ' held file(s) stay. Press Confirm.', 'warn');
      return;
    }
    clearTimeout(armed); armed = 0; state.handing = true; renderDeliver();
    try {
      var report = qcReport(o), reportFile = '';
      if (cfg.upReport && o.passed.length) {
        var rdir = path.join(state.outDir, 'Review'); fs.mkdirSync(rdir, { recursive: true });
        reportFile = path.join(rdir, 'QC_Report_' + N.camel(projName()) + '_' + N.date() + '.md'); fs.writeFileSync(reportFile, report, 'utf8');
      }
      var copied = [];
      if (n && state.driveDir) {
        fs.mkdirSync(state.driveDir, { recursive: true });
        var all = o.files.slice(); if (reportFile) all.push({ f: reportFile, sub: '' });
        for (var i = 0; i < all.length; i++) {
          var dest = path.join(state.driveDir, all[i].sub || '', path.basename(all[i].f));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          status('dstatus', 'Copying ' + (i + 1) + ' of ' + all.length + ' — ' + path.basename(all[i].f));
          await copyFile(all[i].f, dest); copied.push(dest);
        }
      }
      var msg = copied.length ? copied.length + ' files copied to ' + driveLabel(state.driveDir) : '';
      if (cfg.asanaOn || cfg.slackOn) {
        var task = $('asana-task').value.trim() || projName();
        var rel = state.driveDir && drive && state.driveDir.indexOf(drive.root) === 0 ? 'My Drive' + state.driveDir.slice(drive.root.length) : state.driveDir;
        var prompt = ['UAI Smart Export hand-off — ' + projName(), '',
          'QC passed: ' + o.passed.length + ' video(s). Held for fixes: ' + (o.held.map(function (x) { return x.stem; }).join(', ') || 'none') + '.',
          (state.driveDir && drive && state.driveDir.indexOf(drive.root) === 0 ? 'Files are in Google Drive (' + drive.account + '): ' + rel : 'Files were copied to this folder (not a Google Drive folder): ' + rel), ''].concat(
          cfg.asanaOn ? ['1. Asana, project "' + (cfg.asanaProj || 'Creative Requests') + '": find (or create) the task "' + task + '", move it to QC 1 (QC chain Hitesh → Khusi → Johnson → ANIK) and add a comment with the Drive folder link and the QC report below.'] : []).concat(
          cfg.slackOn ? [(cfg.asanaOn ? '2' : '1') + '. Draft a short Slack note for ' + (cfg.slackCh || '[channel not chosen — ask me]') + ' with the Drive link and the QC result. Show me the text and wait for my OK before posting.'] : []).concat(
          ['', 'Show me what you will change and wait for my confirmation before you change anything in Asana or Slack.', '', report]).join('\n');
        await pbcopy(prompt);
        msg += (msg ? '. ' : '') + 'Hand-off prompt copied: paste it into the Claude app';
        cp.execFile('/usr/bin/open', ['-a', 'Claude'], function () {});
      }
      status('dstatus', (msg || 'Done') + '.', 'ok');
    } catch (e) { status('dstatus', 'Stopped: ' + e.message, 'bad'); }
    state.handing = false; renderDeliver();
  }

  // ---------- gamma guard ----------
  function readGamma(file) {
    var buf = fs.readFileSync(file), gz = buf[0] === 0x1f && buf[1] === 0x8b, xml = (gz ? zlib.gunzipSync(buf) : buf).toString('utf8');
    var m, re = /<ColorManagementSettings>([^<]*)<\/ColorManagementSettings>/g, vals = [];
    while ((m = re.exec(xml))) { try { var j = JSON.parse(m[1].replace(/&quot;/g, '"')); vals.push(j.sdrGamma === undefined ? 240 : Number(j.sdrGamma)); } catch (e) {} }
    return { vals: vals, xml: xml, gz: gz };
  }
  function checkGamma() {
    var bar = $('gamma');
    if (!cfg.guard || !state.info || state.gammaHidden[state.info.projectPath]) { bar.hidden = true; return; }
    try {
      var g = readGamma(state.info.projectPath), bad = g.vals.filter(function (v) { return v !== 196; });
      if (!bad.length) { bar.hidden = true; return; }
      $('gammatext').innerHTML = '<b>Preview gamma ' + (bad[0] / 100).toFixed(2) + '</b> in the saved project: exports will look lighter in QuickTime and on phones.';
      bar.hidden = false; $('gammafix').className = ''; $('gammafix').textContent = 'Set 1.96'; $('gammafix').disabled = false;
    } catch (e) { bar.hidden = true; }
  }
  var gammaArm = 0;
  async function fixGamma() {
    var btn = $('gammafix');
    if (!state.info) return;
    if (!gammaArm) { btn.className = 'armed'; btn.textContent = 'Save + reopen?'; gammaArm = setTimeout(function () { gammaArm = 0; btn.className = ''; btn.textContent = 'Set 1.96'; }, 6000); return; }
    clearTimeout(gammaArm); gammaArm = 0; btn.disabled = true; btn.textContent = 'Reopening…';
    var file = state.info.projectPath;
    var r = await evalJsx('ugSaveClose()');
    if (!/^OK:/.test(r)) { btn.disabled = false; btn.className = ''; btn.textContent = 'Set 1.96'; $('gammatext').textContent = 'Could not save/close: ' + String(r).replace(/^ERR:/, ''); return; }
    file = r.slice(3) || file;
    try {
      var g = readGamma(file), n = 0;
      fs.mkdirSync(path.join(APP_DIR, 'backups'), { recursive: true });
      fs.copyFileSync(file, path.join(APP_DIR, 'backups', path.basename(file, '.prproj') + '_' + Date.now() + '.prproj'));
      var xml = g.xml.replace(/<ColorManagementSettings>([^<]*)<\/ColorManagementSettings>/g, function (m, body) {
        try { var quoted = /&quot;/.test(body), j = JSON.parse(body.replace(/&quot;/g, '"')); j.sdrGamma = 196; n++; var s = JSON.stringify(j); return '<ColorManagementSettings>' + (quoted ? s.replace(/"/g, '&quot;') : s) + '</ColorManagementSettings>'; } catch (e) { return m; }
      });
      if (n) fs.writeFileSync(file, g.gz ? zlib.gzipSync(Buffer.from(xml, 'utf8')) : xml);
      var o = await evalJsx('ugOpen(' + q(file) + ')');
      if (!n) $('gammatext').textContent = 'This project has no colour settings block: set File › Project Settings › Color › Viewer Gamma to 1.96 by hand.';
      else if (!/^OK/.test(o)) $('gammatext').textContent = 'Set to 1.96, but Premiere did not reopen it: open ' + path.basename(file) + ' again.';
      btn.disabled = false;
      setTimeout(function () { state.info = null; refresh(); }, 2000);
    } catch (e) {
      btn.disabled = false; $('gammatext').textContent = 'Stopped: ' + e.message + ' (project left as saved).';
      await evalJsx('ugOpen(' + q(file) + ')');
    }
  }

  // ---------- self-update (GitHub) ----------
  function localVersion() { try { return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'version.json'), 'utf8')).version; } catch (e) { return '0.0.0'; } }
  function newer(a, b) { var x = String(a).split('.'), y = String(b).split('.'); for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d > 0; } return false; }
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
      if (err) return;
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

  // ---------- tabs ----------
  function showTab(name) {
    state.tab = name;
    var settings = name === 'settings';
    $('tabs').hidden = settings;
    each($('tabs').children, function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
    ['export', 'qc', 'deliver', 'about', 'settings'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    if (settings) fillSettings();
    if (name === 'deliver') renderDeliver();
  }
  each($('tabs').children, function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

  // ---------- settings panel ----------
  var BIND = { capgb: 'capGb', capmbps: 'capMbps', rule: 'rule', replace: 'replace', autostart: 'autostart', autoqc: 'autoqc', chkFrames: 'chkFrames',
    chkLoud: 'chkLoud', lufs: 'lufs', chkDur: 'chkDur', chkCodec: 'chkCodec', notify: 'notify', pack720: 'pack720', packMB: 'packMB', packSheet: 'packSheet',
    packCover: 'packCover', guard: 'guard', 'up-master': 'upMaster', 'up-social': 'upSocial', 'up-review': 'upReview', 'up-report': 'upReport',
    'asana-on': 'asanaOn', 'asana-proj': 'asanaProj', 'slack-on': 'slackOn', 'slack-ch': 'slackCh' };
  function readEl(el) { return el.type === 'checkbox' ? el.checked : el.type === 'number' ? (isFinite(parseFloat(el.value)) ? parseFloat(el.value) : null) : el.value; }
  function writeEl(el, v) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
  Object.keys(BIND).forEach(function (id) {
    var el = $(id); if (!el) return;
    writeEl(el, cfg[BIND[id]]);
    el.addEventListener(el.type === 'text' ? 'input' : 'change', function () {
      var v = readEl(el); if (v === null) { writeEl(el, cfg[BIND[id]]); return; }
      if (id === 'capgb') v = Math.max(0.2, v); if (id === 'capmbps') v = Math.max(5, v); if (id === 'packMB') v = Math.max(2, v);
      cfg[BIND[id]] = v; saveCfg();
      if (id === 'guard') checkGamma();
      if (state.tab === 'deliver') renderDeliver(); else if (!state.busy) render();
      if (state.tab === 'settings') fillSettings();
    });
  });
  function fillSettings() {
    var normal = state.mode === 'normal', r = gradeRule();
    if (document.activeElement !== $('tpl')) $('tpl').value = tpl();
    $('never').checked = never();
    $('tpllabel').textContent = 'File name template · ' + (normal ? 'Normal export' : 'Colour grading');
    var first = selected()[0];
    $('tplprev').textContent = (first ? first.stem : N.pick(tpl(), { project: projName() || 'Project', sequence: 'Sequence', clip: normal ? 'Clip01' : 'CAM1-0001', ratio: '9x16' }, dirFiles(state.outDir), {}, { never: never() }).stem) + '.mp4';
    $('acvals').hidden = r !== 'ac'; $('clientvals').hidden = r === 'ac';
    $('sum-size').textContent = normal ? 'Normal: match source' : (r === 'ac' ? 'AC · ' + cfg.capGb + ' GB' : 'Client rule') + (cfg.rule === 'auto' ? ' (auto)' : '');
    $('sum-name').textContent = tpl().length > 26 ? tpl().slice(0, 25) + '…' : tpl();
    $('sum-qc').textContent = cfg.autoqc ? [cfg.chkFrames, cfg.chkLoud, cfg.chkDur, cfg.chkCodec].filter(Boolean).length + ' checks' : 'off';
    $('sum-pack').textContent = cfg.review ? 'on · ' + cfg.packMB + ' MB' : 'off (chip on Export)';
    $('sum-guard').textContent = cfg.guard ? 'on' : 'off';
  }
  $('tpl').addEventListener('input', function () { var v = $('tpl').value; if (state.mode === 'normal') cfg.tplNormal = v; else cfg.tplGrade = v; saveCfg(); render(); fillSettings(); });
  $('never').addEventListener('change', function () { if (state.mode === 'normal') cfg.neverNormal = $('never').checked; else cfg.neverGrade = $('never').checked; saveCfg(); render(); fillSettings(); });
  each($('tokens').querySelectorAll('[data-t]'), function (b) {
    b.addEventListener('click', function () {
      var el = $('tpl'), s = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length, e = typeof el.selectionEnd === 'number' ? el.selectionEnd : s;
      if (document.activeElement !== el && !el.dataset.touched) { s = e = el.value.length; }
      var t = b.getAttribute('data-t'), before = el.value.slice(0, s);
      if (before && !/[_\- ]$/.test(before) && t.charAt(0) === '{') t = '_' + t;
      el.value = before + t + el.value.slice(e); el.dataset.touched = '1';
      el.dispatchEvent(new Event('input')); el.focus(); el.setSelectionRange(before.length + t.length, before.length + t.length);
    });
  });
  $('tpl').addEventListener('click', function () { $('tpl').dataset.touched = '1'; });
  $('tplreset').addEventListener('click', function () { if (state.mode === 'normal') cfg.tplNormal = DEF.tplNormal; else cfg.tplGrade = DEF.tplGrade; $('tpl').value = tpl(); saveCfg(); render(); fillSettings(); });
  // one accordion section open at a time
  each($('acc').children, function (d) { d.addEventListener('toggle', function () { if (d.open) each($('acc').children, function (o) { if (o !== d) o.open = false; }); }); });
  $('gear').addEventListener('click', function () { showTab(state.tab === 'settings' ? 'export' : 'settings'); });
  $('outline').addEventListener('click', function () { showTab('settings'); });
  $('setback').addEventListener('click', function () { showTab('export'); });
  $('setdone').addEventListener('click', function () { showTab('export'); });

  // ---------- wiring ----------
  $('mode').addEventListener('change', function () {
    if (state.busy) { $('mode').value = state.mode; return; }
    state.mode = $('mode').value; store('opt:mode', state.mode); status('status', '');
    if (state.info) { loadOutDir(); showOutDir(); }
    refresh();
  });
  $('scope').addEventListener('change', function () { if (state.busy) { $('scope').value = state.scope; return; } state.scope = $('scope').value; refresh(); });
  $('nscope').addEventListener('change', function () { if (state.busy) { $('nscope').value = state.nscope; return; } state.nscope = $('nscope').value; store('opt:nscope', state.nscope); refresh(); });
  $('out-social').addEventListener('click', function () { cfg.social = !cfg.social; saveCfg(); render(); });
  $('out-review').addEventListener('click', function () { cfg.review = !cfg.review; saveCfg(); render(); });
  $('selall').addEventListener('click', function () { if (state.busy) return; var allOn = state.plan.every(function (p) { return p.on; }); state.plan.forEach(function (p) { state.off[p.key] = allOn; }); render(); });
  $('selactive').addEventListener('click', function () { if (state.busy || !state.info) return; state.plan.forEach(function (p) { state.off[p.key] = p.seqId !== state.info.activeId; }); render(); });
  $('refresh').addEventListener('click', function () { refresh().then(checkGamma); });
  $('browse').addEventListener('click', async function () {
    if (!state.info || state.busy) return;
    var picked = await evalJsx('ugPickFolder(' + q(fs.existsSync(state.outDir) ? state.outDir : path.dirname(state.outDir)) + ')');
    if (picked && picked !== 'EvalScript error.') { state.outDir = picked; store('out:' + state.info.projectPath, picked); showOutDir(); render(); }
  });
  $('resetdir').addEventListener('click', function () { if (!state.info || state.busy) return; store('out:' + state.info.projectPath, null); loadOutDir(); showOutDir(); render(); });
  $('reveal').addEventListener('click', function () { openPath(state.outDir); });
  $('go').addEventListener('click', run);
  $('toqc').addEventListener('click', checkAll);
  $('qrun').addEventListener('click', function () { state.qcItems.forEach(function (it) { if (it.state === 'missing' && fs.existsSync(it.file)) it.state = 'rendered'; }); checkAll(); });
  $('qdeliver').addEventListener('click', function () { showTab('deliver'); });
  $('driveacctsel').addEventListener('change', function () {
    cfg.driveAcct = $('driveacctsel').value; saveCfg();
    if (state.info) store('drive:' + state.info.projectPath, null);
    loadDeliver();
  });
  $('drivebrowse').addEventListener('click', async function () {
    if (!state.info) return;
    var start = state.driveDir && fs.existsSync(state.driveDir) ? state.driveDir : drive ? drive.root : os.homedir();
    var picked = await evalJsx('ugPickFolder(' + q(start) + ',' + q('Choose the delivery folder (inside Google Drive)') + ')');
    if (picked && picked !== 'EvalScript error.') { state.driveDir = picked; store('drive:' + state.info.projectPath, picked); renderDeliver(); }
  });
  $('asana-task').addEventListener('input', function () { if (state.info) store('task:' + state.info.projectPath, $('asana-task').value); });
  $('handoff').addEventListener('click', handoff);
  $('gammafix').addEventListener('click', fixGamma);
  $('gammax').addEventListener('click', function () { if (state.info) state.gammaHidden[state.info.projectPath] = true; $('gamma').hidden = true; });
  $('updatebtn').addEventListener('click', applyUpdate);
  $('probestate').textContent = Q.FFPROBE && Q.FFMPEG ? 'ffmpeg found: QC, Social and Review pack work' : 'ffmpeg missing: QC, Social and Review pack need it (brew install ffmpeg)';
  $('probestate').className = 'chip ' + (Q.FFPROBE && Q.FFMPEG ? 'ok' : 'warn');

  var lastFocus = 0;
  window.addEventListener('focus', function () { var t = Date.now(); if (state.busy || t - lastFocus < 1500) return; lastFocus = t; refresh(); });

  // ---------- Undo / Redo (Premiere's own history) ----------
  var histTimer = 0;
  async function history(dir) {
    var r = await evalJsx('uaiHistory(' + JSON.stringify(dir) + ')'), el = $('hmsg');
    var ok = /^OK:/.test(r), moved = ok ? r.slice(3) : '0';
    el.textContent = !ok ? 'Undo not available' : moved === '0' ? 'Nothing to ' + dir : (dir === 'undo' ? 'Undone' : 'Redone');
    el.className = 'hmsg' + (ok && moved !== '0' ? ' on' : '');
    clearTimeout(histTimer); histTimer = setTimeout(function () { el.textContent = ''; el.className = 'hmsg'; }, 2200);
    if (ok && moved !== '0') refresh();
  }
  $('hundo').addEventListener('click', function () { history('undo'); });
  $('hredo').addEventListener('click', function () { history('redo'); });
  document.addEventListener('keydown', function (ev) {
    if (!(ev.metaKey || ev.ctrlKey) || String(ev.key).toLowerCase() !== 'z') return;
    var t = ev.target && ev.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    ev.preventDefault(); history(ev.shiftKey ? 'redo' : 'undo');
  });

  // ---------- About: New updates (latest open, older ones fold) ----------
  (function renderUpdates() {
    var box = $('updates'); if (!box) return;
    var log; try { log = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'changelog.json'), 'utf8')); } catch (e) { box.textContent = 'No update history in this install.'; return; }
    box.innerHTML = '';
    (log.entries || []).forEach(function (e, i) {
      var d = new Date(e.date), card = document.createElement(i === 0 ? 'div' : 'details');
      card.className = 'upd' + (i === 0 ? ' latest' : '');
      var head = document.createElement(i === 0 ? 'div' : 'summary'); head.className = 'uh'; head.innerHTML = '<b></b><span></span>';
      head.querySelector('b').textContent = 'v' + e.version + (i === 0 ? ' · installed' : '');
      head.querySelector('span').textContent = isNaN(d) ? e.date : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      card.appendChild(head);
      (e.changes || []).forEach(function (c) {
        var row = document.createElement('div'); row.className = 'uc';
        row.innerHTML = '<span class="w"></span><span class="b"></span><span class="n"></span>';
        row.children[0].textContent = c.what; row.children[1].textContent = c.before; row.children[2].textContent = c.now;
        card.appendChild(row);
      });
      box.appendChild(card);
    });
  })();

  checkUpdate();
  syncMode();
  refresh();
})();
