/* UAI Luma Cut — panel logic.
   Build: client folder -> read clips -> plan (Standalone: audio trim + house grade / Claude: luma_plan.json)
          -> one FCP XML -> imported into the open project -> S-log columns -> save.
   Grade / Review: follow-up work on the built timeline. */
(function () {
  'use strict';
  var nodeReq = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var fs = nodeReq('fs'), path = nodeReq('path'), os = nodeReq('os'), cp = nodeReq('child_process'), https = nodeReq('https'), crypto = nodeReq('crypto');
  var EXT_DIR = decodeURI(window.location.pathname).replace(/\/index\.html$/, '');
  var XB = nodeReq(path.join(EXT_DIR, 'lib', 'xmlbuild.js'));
  var MP4 = nodeReq(path.join(EXT_DIR, 'lib', 'mp4probe.js'));
  var SPEECH = nodeReq(path.join(EXT_DIR, 'lib', 'speech.js'));
  var REPO = 'agentixclaude/uai-smart-export';
  var VERSION_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/luma-cut/version.json';
  var ZIP_URL = 'https://codeload.github.com/' + REPO + '/zip/refs/heads/main';
  var ENGINE_DIR = path.join(os.homedir(), 'UAI Luma Cut', 'engine');
  var LUT_REL = 'Lumetri/LUTs/Technical/ALEXA_Default_LogC2Rec709.cube';
  var VIDEO_RE = /\.(mp4|mov|mxf)$/i;

  var $ = function (id) { return document.getElementById(id); };
  var q = function (s) { return JSON.stringify(String(s)); };
  function evalJsx(script) { return new Promise(function (resolve) { window.__adobe_cep__.evalScript(script, function (r) { resolve(r); }); }); }
  async function jsx(script) { var r = await evalJsx(script); try { return JSON.parse(r); } catch (e) { return { error: r && r !== 'EvalScript error.' ? r : 'Premiere did not answer. Reopen the panel.' }; } }
  function setStatus(id, text, tone) { var el = $(id); el.textContent = text || ''; el.className = 'status' + (tone ? ' tone-' + tone : ''); }
  function fmtDur(s) { s = Math.max(0, s); var m = Math.floor(s / 60), r = Math.round(s - m * 60); if (r === 60) { m++; r = 0; } return m + ':' + (r < 10 ? '0' : '') + r; }
  function store(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }

  var state = { info: null, client: null, clips: [], skipped: [], mode: load('lc:mode') || 'standalone', plan: null, request: null, busy: false, armed: 0, ffmpeg: SPEECH.findFfmpeg() };

  // ---------------- client folder ----------------
  function subdir(dir, re) {
    try { return fs.readdirSync(dir).filter(function (n) { return re.test(n) && fs.statSync(path.join(dir, n)).isDirectory(); })[0] || null; } catch (e) { return null; }
  }
  function clientName(folder) {
    var base = path.basename(folder).trim();
    var m = base.match(/^AC\s*#?\s*(\d+)[\s\-–_]*(.*)$/i);
    var words = function (s) { return s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(''); };
    if (m) return 'AC' + m[1] + (m[2] ? '_' + words(m[2]) : '');
    return words(base) || 'Client';
  }
  function isAc(folder) { return /(^|[^A-Za-z])AC\s*#?\s*\d+/i.test(path.basename(folder)) || /^AC([^A-Za-z]|$)/i.test(path.basename(folder)); }
  function openClient(dir) {
    if (!dir || !fs.existsSync(dir)) { state.client = null; renderClient(); return; }
    var raw = subdir(dir, /^raw/i), proj = subdir(dir, /^(project ?files?|source|project)$/i), out = subdir(dir, /^final[ _-]?outputs?$/i);
    state.client = {
      dir: dir, name: clientName(dir), ac: isAc(dir),
      rawRel: raw, projRel: proj || 'Project File', outRel: out || 'Final Output'
    };
    state.client.rawDir = raw ? path.join(dir, raw) : null;
    state.client.projDir = path.join(dir, state.client.projRel);
    state.client.planFile = path.join(state.client.projDir, 'luma_plan.json');
    state.client.requestFile = path.join(state.client.projDir, 'luma_request.json');
    state.client.projectFile = path.join(state.client.projDir, state.client.name + '_GRADED.prproj');
    state.client.xmlFile = path.join(state.client.projDir, state.client.name + '_GRADED.xml');
    store('lc:client', dir);
    scanClips(); loadPlan(); renderClient();
  }
  function scanClips() {
    state.clips = []; state.skipped = [];
    var c = state.client; if (!c || !c.rawDir) return;
    var names = fs.readdirSync(c.rawDir).filter(function (n) { return VIDEO_RE.test(n) && n.charAt(0) !== '.'; }).sort();
    names.forEach(function (n) {
      var p = path.join(c.rawDir, n);
      if (/ \(\d+\)\.[^.]+$/.test(n)) { state.skipped.push({ file: n, why: 'duplicate copy' }); return; }
      try {
        var m = MP4.probe(p);
        state.clips.push({ file: n, path: p, rel: path.relative(c.dir, p), w: m.w, h: m.h, raw_w: m.raw_w, raw_h: m.raw_h, rot: m.rot, fps: m.fps, frames: m.frames, seconds: m.seconds });
      } catch (e) { state.skipped.push({ file: n, why: e.message }); }
    });
  }
  function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
  function loadPlan() {
    var c = state.client; state.plan = null; state.request = null;
    if (!c) return;
    state.request = readJson(c.requestFile);
    var plan = readJson(c.planFile);
    if (plan && Array.isArray(plan.clips) && plan.clips.length) state.plan = plan;
  }
  function planFor(file) {
    if (!state.plan) return null;
    for (var i = 0; i < state.plan.clips.length; i++) if (state.plan.clips[i].file === file) return state.plan.clips[i];
    return null;
  }
  function claudePlanReady() {
    return !!(state.plan && state.plan.source === 'claude' && (!state.request || state.plan.requestId === state.request.requestId));
  }

  // ---------------- render: build tab ----------------
  function renderClient() {
    var c = state.client, el = $('clientdir');
    el.textContent = c ? c.dir : 'Choose the client\'s folder (the one holding Raw Data and Project File).';
    el.className = 'path' + (c ? '' : ' empty');
    $('reveal').disabled = !c;
    var ac = $('acchip');
    ac.hidden = !c; ac.textContent = c && c.ac ? 'AC client' : 'Client'; ac.className = 'chip' + (c && c.ac ? ' accent' : '');
    var meta = '';
    if (c) {
      meta = !c.rawDir ? 'No Raw folder inside. Add one named "Raw" or "Raw Data".'
        : state.clips.length + (state.clips.length === 1 ? ' clip' : ' clips') + ' in ' + c.rawRel + (state.skipped.length ? ' · ' + state.skipped.length + ' skipped' : '') +
          ' · builds ' + c.name + '_GRADED';
    }
    $('clientmeta').textContent = meta;
    $('clientmeta').className = 'note' + (c && !c.rawDir ? ' tone-warn' : '');
    renderMode(); renderClips(); renderTarget();
  }
  function renderMode() {
    Array.prototype.forEach.call($('mode').children, function (b) { b.className = b.getAttribute('data-v') === state.mode ? 'on' : ''; });
    var claude = state.mode === 'claude';
    $('claudebox').hidden = !claude;
    $('modenote').textContent = claude
      ? 'Claude checks faces for a closed mouth and open eyes and matches the grade per clip. Takes a few minutes per client.'
      : state.ffmpeg ? 'Trims from the audio and applies the house grade. Runs in seconds, no Claude needed.'
                     : 'ffmpeg is not installed, so clips keep their full length and are flagged. Install it with: brew install ffmpeg';
    $('modenote').className = 'note' + (!claude && !state.ffmpeg ? ' tone-warn' : '');
    var ps = $('planstate');
    if (claudePlanReady()) {
      var flags = state.plan.clips.filter(function (x) { return x.flag; }).length;
      ps.textContent = 'Plan ready · ' + state.plan.clips.length + ' clips' + (flags ? ' · ' + flags + ' to check' : '');
      ps.className = 'chip ok';
    } else if (state.request && claude) { ps.textContent = 'Waiting for Claude…'; ps.className = 'chip warn'; }
    else { ps.textContent = 'No plan yet'; ps.className = 'chip'; }
    $('prompt').hidden = !(claude && state.request && !claudePlanReady());
    if (!$('prompt').hidden) $('prompt').textContent = promptText();
  }
  function seqKey(c) { var k = XB.sizeKey(c); return k.tier + ' ' + k.orient; }
  function renderClips() {
    var list = $('clips'); list.innerHTML = '';
    if (!state.client) { list.innerHTML = '<div class="empty">Choose a client folder to see its clips.</div>'; return; }
    if (!state.clips.length && !state.skipped.length) { list.innerHTML = '<div class="empty">No video files in the Raw folder.</div>'; return; }
    var groups = {}, order = [];
    state.clips.forEach(function (c) { var k = seqKey(c); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(c); });
    order.sort().forEach(function (k) {
      var h = document.createElement('div'); h.className = 'head';
      var g = groups[k];
      h.innerHTML = '<span></span><span class="muted"></span>';
      h.children[0].textContent = state.client.name + '_' + k.replace(' ', '_');
      h.children[1].textContent = g[0].w + '×' + g[0].h + ' · ' + g.length + (g.length === 1 ? ' clip' : ' clips');
      list.appendChild(h);
      g.forEach(function (c) {
        var p = usablePlan(c), row = document.createElement('div');
        row.className = 'clip' + (p && p.flag ? ' flag' : '');
        row.innerHTML = '<span class="n"></span><span class="t"></span><span class="chip"></span>';
        row.children[0].textContent = c.file;
        row.children[0].title = p && p.flag ? p.flag : c.file;
        var fps = c.fps || 29.97;
        row.children[1].textContent = p ? fmtDur(p['in'] / fps) + ' → ' + fmtDur((p.out + 1) / fps) : fmtDur(c.seconds);
        var chip = row.children[2];
        if (!p) { chip.textContent = 'not trimmed'; }
        else if (p.flag) { chip.textContent = 'check'; chip.className = 'chip warn'; }
        else { chip.textContent = state.plan.source === 'claude' ? 'face' : 'audio'; chip.className = 'chip ok'; }
        list.appendChild(row);
      });
    });
    state.skipped.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'clip skip';
      row.innerHTML = '<span class="n"></span><span class="t"></span><span class="chip">skipped</span>';
      row.children[0].textContent = s.file; row.children[1].textContent = s.why; list.appendChild(row);
    });
  }
  // a plan entry counts only for the current mode (a Standalone plan is not shown as Claude's)
  function usablePlan(c) {
    if (!state.plan) return null;
    if (state.mode === 'claude' && !claudePlanReady()) return null;
    return planFor(c.file);
  }
  function samePath(a, b) { return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase(); }
  function renderTarget() {
    var i = state.info, c = state.client, t = $('target'), np = $('newproj');
    var projectOk = !!(i && i.open), inClient = projectOk && c && String(i.projectPath).toLowerCase().indexOf(c.dir.toLowerCase() + '/') === 0;
    if (!c) { t.textContent = ''; np.hidden = true; }
    else if (!projectOk) { t.textContent = 'No project open'; t.className = 'muted tone-warn'; np.hidden = false; }
    else {
      t.textContent = 'Into ' + i.projectName.replace(/\.prproj$/i, '') + (inClient ? '' : ' (other folder)');
      t.className = 'muted' + (inClient ? '' : ' tone-warn');
      np.hidden = inClient;
    }
    var b = $('build');
    var ready = c && c.rawDir && state.clips.length && projectOk && !state.busy && (state.mode === 'standalone' || claudePlanReady());
    b.disabled = !ready;
    if (state.armed && Date.now() - state.armed < 4000) { b.textContent = 'Click again to replace the Sequences bin'; b.className = 'primary armed'; return; }
    state.armed = 0; b.className = 'primary';
    var rebuild = projectOk && i.hasSequencesBin;
    b.textContent = state.mode === 'claude' ? (rebuild ? 'Rebuild from Claude\'s plan' : 'Build from Claude\'s plan') : (rebuild ? 'Analyse and rebuild' : 'Analyse and build');
  }

  // ---------------- Claude mode ----------------
  function promptText() {
    var c = state.client;
    return 'Luma Cut: make the trim and grade plan for ' + c.name + '.\nRequest file: ' + c.requestFile +
      '\nEngine: ' + ENGINE_DIR + '\nWrite luma_plan.json next to the request file.';
  }
  function writeRequest() {
    var c = state.client;
    var req = {
      version: 1, requestId: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(),
      client: c.name, ac: c.ac, clientDir: c.dir, projRel: c.projRel, rawRel: c.rawRel, engine: ENGINE_DIR,
      rules: { preRoll: SPEECH.PRE, postRoll: SPEECH.POST, house: XB.HOUSE },
      clips: state.clips.map(function (x) { return { file: x.file, rel: x.rel, path: x.path, w: x.w, h: x.h, raw_w: x.raw_w, raw_h: x.raw_h, rot: x.rot, fps: x.fps, frames: x.frames }; })
    };
    fs.mkdirSync(c.projDir, { recursive: true });
    fs.writeFileSync(c.requestFile, JSON.stringify(req, null, 1));
    state.request = req;
    return req;
  }
  $('askclaude').addEventListener('click', function () {
    if (!state.client || !state.clips.length) { setStatus('status', 'Choose a client folder with clips first.', 'warn'); return; }
    try {
      writeRequest();
      var p = cp.spawn('/usr/bin/pbcopy'); p.stdin.end(promptText());
      setStatus('status', 'Prompt copied. Paste it into Claude (desktop app, this computer). The plan appears here when Claude is done.', 'ok');
    } catch (e) { setStatus('status', 'Could not write the request: ' + e.message, 'bad'); }
    renderMode(); renderClips(); renderTarget();
  });
  // watch for the plan while waiting
  setInterval(function () {
    if (!state.client || state.mode !== 'claude' || state.busy || claudePlanReady() || !state.request) return;
    var was = !!state.plan; loadPlan();
    if (claudePlanReady()) { renderMode(); renderClips(); renderTarget(); setStatus('status', 'Claude\'s plan is ready. Press Build.', 'ok'); }
    else if (state.plan && !was) { renderClips(); }
  }, 3000);

  // ---------------- Standalone analysis ----------------
  function analyseClip(c) {
    return new Promise(function (resolve) {
      var fps = c.fps || 29.97;
      if (!state.ffmpeg) return resolve({ inF: 0, outF: c.frames - 1, flag: 'ffmpeg missing - set IN/OUT by hand' });
      SPEECH.speechBounds(state.ffmpeg, c.path, function (err, b) {
        if (err) return resolve({ inF: 0, outF: c.frames - 1, flag: 'audio could not be read - set IN/OUT by hand' });
        resolve(SPEECH.trimFrames(b, fps, c.frames));
      });
    });
  }
  async function standalonePlan(progress) {
    var clips = [];
    for (var i = 0; i < state.clips.length; i++) {
      var c = state.clips[i];
      progress(i, state.clips.length, 'Reading audio ' + (i + 1) + ' of ' + state.clips.length + ' — ' + c.file);
      var t = await analyseClip(c);
      clips.push({ file: c.file, path: c.path, w: c.w, h: c.h, rot: c.rot, fps: c.fps, frames: c.frames, 'in': t.inF, out: t.outF, flag: t.flag, grade: XB.HOUSE });
    }
    var plan = { version: 1, source: 'standalone', client: state.client.name, createdAt: new Date().toISOString(), clips: clips };
    fs.mkdirSync(state.client.projDir, { recursive: true });
    fs.writeFileSync(state.client.planFile, JSON.stringify(plan, null, 1));
    state.plan = plan; state.request = null;
    try { fs.unlinkSync(state.client.requestFile); } catch (e) {}
    return plan;
  }

  // ---------------- build ----------------
  function findLut(appPath) {
    var tries = [];
    if (appPath) {
      var app = String(appPath).replace(/\/+$/, ''), m = app.match(/^(.*?\.app)/);
      if (m) tries.push(path.join(m[1], 'Contents', LUT_REL));
    }
    try {
      fs.readdirSync('/Applications').filter(function (n) { return /^Adobe Premiere Pro/.test(n); }).sort().reverse().forEach(function (d) {
        try { fs.readdirSync(path.join('/Applications', d)).filter(function (n) { return /\.app$/.test(n); }).forEach(function (a) { tries.push(path.join('/Applications', d, a, 'Contents', LUT_REL)); }); } catch (e) {}
      });
    } catch (e) {}
    for (var i = 0; i < tries.length; i++) if (fs.existsSync(tries[i])) return tries[i];
    return null;
  }
  function progress(i, n, text) {
    $('progress').hidden = false; $('progress').firstChild.style.width = Math.round(100 * i / Math.max(1, n)) + '%';
    setStatus('status', text);
  }
  async function build() {
    if (state.busy) return;
    var info = await jsx('lcInfo()');
    state.info = info.error ? null : info;
    if (!info.open) { renderTarget(); setStatus('status', 'Open the client project, or press New project for this client.', 'warn'); return; }
    if (info.hasSequencesBin && !(state.armed && Date.now() - state.armed < 4000)) { state.armed = Date.now(); renderTarget(); setTimeout(renderTarget, 4100); return; }
    state.armed = 0;
    var lut = findLut(info.appPath);
    if (!lut) { setStatus('status', 'Premiere\'s ALEXA LUT was not found. Reinstall Premiere Pro.', 'bad'); return; }
    state.busy = true; renderTarget(); $('build').className = 'primary busy';
    try {
      var plan = state.mode === 'claude' ? state.plan : await standalonePlan(progress);
      if (state.mode === 'claude' && !claudePlanReady()) throw new Error('Claude\'s plan is not ready yet');
      progress(0.9, 1, 'Writing the XML…');
      var template = fs.readFileSync(path.join(EXT_DIR, 'lumetri', 'filter.xml'), 'utf8');
      var res = XB.build(plan, { template: template, lutPath: lut });
      fs.mkdirSync(state.client.projDir, { recursive: true });
      fs.writeFileSync(state.client.xmlFile, res.xml);
      if (info.hasSequencesBin) {
        progress(0.92, 1, 'Removing the old build…');
        var cl = await evalJsx('lcClearBuild()');
        if (!/^OK/.test(cl)) throw new Error(String(cl).replace(/^ERR:/, ''));
      }
      progress(0.95, 1, 'Importing into Premiere…');
      var imp = await jsx('lcImportXml(' + q(state.client.xmlFile) + ')');
      if (imp.error) throw new Error(imp.error.replace(/^ERR:/, ''));
      var cols = fs.readFileSync(path.join(EXT_DIR, 'columns', 's-log.xml'), 'utf8');
      await evalJsx('lcColumns(' + q(cols) + ')');
      await evalJsx('lcSave()');
      $('progress').firstChild.style.width = '100%';
      var flagged = res.review.length;
      setStatus('status', 'Built ' + res.sequences.map(function (s) { return s.name; }).join(', ') + ' · ' + plan.clips.length + ' clips' +
        (flagged ? ' · ' + flagged + ' to check in Review' : '') + '. To sort, click the Video Info header twice.', flagged ? 'warn' : 'ok');
    } catch (e) {
      setStatus('status', 'Stopped: ' + e.message, 'bad');
    }
    state.busy = false;
    setTimeout(function () { $('progress').hidden = true; }, 1200);
    await refresh();
  }
  $('build').addEventListener('click', build);
  $('newproj').addEventListener('click', async function () {
    var c = state.client; if (!c || state.busy) return;
    fs.mkdirSync(c.projDir, { recursive: true });
    var r = await evalJsx('lcNewProject(' + q(c.projectFile) + ')');
    if (/^OK/.test(r)) setStatus('status', (r === 'OK:opened' ? 'Opened ' : 'Created ') + path.basename(c.projectFile) + '.', 'ok');
    else setStatus('status', 'Could not create the project: ' + String(r).replace(/^ERR:/, ''), 'bad');
    setTimeout(refresh, 800);
  });

  // ---------------- folder buttons ----------------
  $('browse').addEventListener('click', async function () {
    if (state.busy) return;
    var start = state.client ? path.dirname(state.client.dir) : (state.info && state.info.open ? path.dirname(path.dirname(state.info.projectPath)) : '');
    var picked = await evalJsx('lcPickFolder(' + q(start) + ',"Choose the client folder")');
    if (picked && picked !== 'EvalScript error.') { openClient(picked); setStatus('status', ''); }
  });
  $('reveal').addEventListener('click', function () { if (state.client) cp.execFile('/usr/bin/open', [state.client.dir]); });
  Array.prototype.forEach.call($('mode').children, function (b) {
    b.addEventListener('click', function () {
      if (state.busy) return;
      state.mode = b.getAttribute('data-v'); store('lc:mode', state.mode);
      loadPlan(); renderMode(); renderClips(); renderTarget(); setStatus('status', '');
    });
  });

  // ---------------- refresh ----------------
  async function refresh() {
    var info = await jsx('lcInfo()');
    state.info = info.error ? null : info;
    $('project').textContent = info.error ? info.error : info.open ? info.projectName.replace(/\.prproj$/i, '') : 'No project open';
    // follow the open project to its client folder when none is chosen
    if (!state.client && info.open) {
      var guess = path.dirname(path.dirname(info.projectPath));
      if (subdir(guess, /^raw/i)) openClient(guess);
    }
    if (state.client && !state.busy) { loadPlan(); }
    var pc = $('projchip');
    if (info.open && state.client) {
      var inClient = String(info.projectPath).toLowerCase().indexOf(state.client.dir.toLowerCase() + '/') === 0;
      pc.hidden = inClient; pc.textContent = 'other client'; pc.className = 'chip warn';
    } else pc.hidden = true;
    renderMode(); renderClips(); renderTarget();
    $('ffmpegstate').textContent = state.ffmpeg ? 'ffmpeg found' : 'ffmpeg missing';
    $('ffmpegstate').className = 'chip' + (state.ffmpeg ? ' ok' : ' warn');
  }
  $('refresh').addEventListener('click', function () { if (state.client) { scanClips(); } refresh(); refreshTab(); });

  // ---------------- tabs ----------------
  var activeTab = 'build';
  function showTab(name) {
    activeTab = name;
    Array.prototype.forEach.call($('tabs').children, function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
    ['build', 'grade', 'review', 'about'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    refreshTab();
  }
  function refreshTab() { if (activeTab === 'grade') gradeRefresh(); if (activeTab === 'review') reviewRefresh(); }
  Array.prototype.forEach.call($('tabs').children, function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

  // ---------------- grade ----------------
  var G_PARAMS = [['exposure', 'Exposure', 0.1], ['temperature', 'Temperature', 2], ['tint', 'Tint', 1], ['saturation', 'Saturation', 2], ['contrast', 'Contrast', 2],
                  ['highlights', 'Highlights', 5], ['shadows', 'Shadows', 5], ['whites', 'Whites', 5], ['blacks', 'Blacks', 5]];
  var G_ORDER = ['temperature', 'tint', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
  var grade = { scope: 'selected', copied: null };
  function plural(n) { return n + (n === 1 ? ' clip' : ' clips'); }
  function gradeShow(d) {
    if (d.error) { $('gtarget').textContent = d.error; return; }
    $('gtarget').textContent = d.count === 0 ? (grade.scope === 'selected' ? 'Select clips in the timeline, then press Refresh.' : 'No enabled clips on V1 of the active sequence.')
      : d.graded === 0 ? 'No Lumetri Color on ' + (d.count === 1 ? 'this clip.' : 'these clips.')
      : plural(d.graded) + (d.graded > 1 ? ' — values shown for ' + d.name : ' — ' + d.name);
    G_PARAMS.forEach(function (p) { var v = d.values ? d.values[p[0]] : null; $('gv-' + p[0]).textContent = (v === null || v === undefined) ? '–' : v; });
    Array.prototype.forEach.call($('gparams').querySelectorAll('button'), function (b) { b.disabled = !(d.graded > 0); });
  }
  async function gradeRefresh() { gradeShow(await jsx('lcGradeRead(' + q(grade.scope) + ')')); }
  G_PARAMS.forEach(function (p) {
    var row = document.createElement('div'); row.className = 'prow';
    row.innerHTML = '<span></span><span class="v" id="gv-' + p[0] + '">–</span><button disabled></button><button disabled></button>';
    row.children[0].textContent = p[1];
    [-1, 1].forEach(function (sign, i) {
      var b = row.children[2 + i];
      b.textContent = sign > 0 ? '+' : '−'; b.title = (sign > 0 ? 'Raise ' : 'Lower ') + p[1].toLowerCase() + ' by ' + p[2];
      b.addEventListener('click', async function () {
        var d = await jsx('lcGradeNudge(' + q(grade.scope) + ',' + q(p[0]) + ',' + (sign * p[2]) + ')');
        gradeShow(d);
        if (!d.error) setStatus('gstatus', p[1] + ' ' + (sign > 0 ? '+' : '−') + p[2] + ' on ' + plural(d.graded) + '.');
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
  $('gcopy').addEventListener('click', async function () {
    var d = await jsx('lcGradeRead("selected")');
    if (d.error || !d.graded) { setStatus('gstatus', d.error || 'Select one graded clip in the timeline first.', 'warn'); return; }
    grade.copied = { name: d.name, camera: d.camera, values: d.values };
    $('gclip').textContent = 'Copied from ' + d.name + ' (camera ' + d.camera + ').';
    $('gpaste').disabled = false; $('gpastecam').disabled = false;
    $('gpastecam').textContent = 'Paste to all ' + d.camera + ' clips';
    setStatus('gstatus', '');
  });
  async function gradePaste(scope) {
    if (!grade.copied) return;
    var csv = G_ORDER.map(function (k) { var v = grade.copied.values[k]; return (v === null || v === undefined) ? 'x' : v; }).join(',');
    var r = await evalJsx('lcGradeApply(' + q(scope) + ',' + q(grade.copied.camera) + ',' + q(csv) + ')');
    if (/^OK:/.test(r)) setStatus('gstatus', 'Pasted to ' + plural(parseInt(r.slice(3), 10)) + '.', 'ok');
    else setStatus('gstatus', 'Paste failed: ' + String(r).replace(/^ERR:/, ''), 'bad');
    gradeRefresh();
  }
  $('gpaste').addEventListener('click', function () { gradePaste('selected'); });
  $('gpastecam').addEventListener('click', function () { gradePaste('camera'); });

  // ---------------- review ----------------
  var review = { data: null, sscope: 'selected' };
  function isFlag(mk) { return /review/i.test(mk.name + ' ' + mk.comments); }
  function flagsFor(name) { return review.data ? review.data.markers.filter(function (mk) { return isFlag(mk) && mk.name.replace(/^(IN|OUT) /, '') === name; }) : []; }
  async function reviewRefresh() {
    var d = await jsx('lcReview()'), list = $('rlist'); list.innerHTML = '';
    if (d.error) { review.data = null; list.innerHTML = '<div class="empty"></div>'; list.firstChild.textContent = d.error; return; }
    review.data = d;
    var frame = Number(d.timebase);
    var head = document.createElement('div'); head.className = 'head';
    var nFlags = d.markers.filter(isFlag).length;
    head.innerHTML = '<span></span><span class="muted"></span>';
    head.children[0].textContent = d.sequence; head.children[1].textContent = plural(d.clips.length) + (nFlags ? ' · ' + nFlags + ' flagged' : '');
    list.appendChild(head);
    if (!d.clips.length) { var e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No enabled clips on V1.'; list.appendChild(e); return; }
    var seen = {};
    d.clips.forEach(function (c) {
      if (seen[c.name]) return; seen[c.name] = true;
      var flags = flagsFor(c.name), row = document.createElement('div');
      row.className = 'rclip' + (flags.length ? ' flag' : '');
      row.innerHTML = '<div class="top"><span class="n"></span><span class="muted"></span></div><div class="marks"><button></button><button></button></div>';
      row.querySelector('.n').textContent = c.name;
      row.querySelector('.top .muted').textContent = fmtDur(c.end - c.start);
      var bIn = row.querySelectorAll('.marks button')[0], bOut = row.querySelectorAll('.marks button')[1];
      bIn.textContent = 'IN ' + fmtDur(c.start); bOut.textContent = 'OUT ' + fmtDur(c.end);
      bIn.title = 'Jump to the first frame'; bOut.title = 'Jump to the last frame';
      bIn.addEventListener('click', function () { go(c.startTicks, c.name + ' IN'); });
      bOut.addEventListener('click', function () { go(String(Number(c.endTicks) - frame), c.name + ' OUT'); });
      if (flags.length) { var w = document.createElement('div'); w.className = 'why'; w.textContent = flags.map(function (f) { return f.comments; }).join(' · '); row.appendChild(w); }
      list.appendChild(row);
    });
  }
  async function go(ticks, label) { await evalJsx('lcGoto(' + q(ticks) + ')'); if (review.data) review.data.position = ticks; setStatus('rstatus', label); }
  function step(dir) {
    var rows = review.data ? review.data.markers.filter(isFlag) : [];
    if (!rows.length) { setStatus('rstatus', 'Nothing flagged in this sequence.', 'ok'); return; }
    var pos = Number(review.data.position), pick;
    if (dir > 0) pick = rows.filter(function (mk) { return Number(mk.ticks) > pos; })[0] || rows[0];
    else { var before = rows.filter(function (mk) { return Number(mk.ticks) < pos; }); pick = before[before.length - 1] || rows[rows.length - 1]; }
    go(pick.ticks, pick.name + ' — ' + pick.comments);
  }
  $('rnext').addEventListener('click', function () { step(1); });
  $('rprev').addEventListener('click', function () { step(-1); });
  $('rsync').addEventListener('click', async function () {
    var r = await evalJsx('lcSyncMarkers()');
    if (/^OK:/.test(r)) setStatus('rstatus', r.slice(3) + ' markers placed on the clips\' first and last frames.', 'ok');
    else setStatus('rstatus', 'Could not re-sync: ' + String(r).replace(/^ERR:/, ''), 'bad');
    reviewRefresh();
  });
  Array.prototype.forEach.call($('sscope').children, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call($('sscope').children, function (x) { x.className = x === b ? 'on' : ''; });
      review.sscope = b.getAttribute('data-v');
    });
  });
  function stillsDir() {
    if (state.client) return path.join(state.client.dir, 'QC Stills');
    return state.info && state.info.open ? path.join(path.dirname(path.dirname(state.info.projectPath)), 'QC Stills') : '';
  }
  $('rstills').addEventListener('click', async function () {
    if (state.busy) return;
    await reviewRefresh();
    var d = review.data; if (!d) return;
    var frame = Number(d.timebase), flagged = {};
    d.markers.filter(isFlag).forEach(function (mk) { flagged[mk.name.replace(/^(IN|OUT) /, '')] = true; });
    var clips = d.clips.filter(function (c) { return review.sscope === 'all' || (review.sscope === 'selected' ? c.selected : flagged[c.name]); });
    if (!clips.length) { setStatus('rstatus', review.sscope === 'selected' ? 'Select clips in the timeline first.' : 'No matching clips.', 'warn'); return; }
    state.busy = true; $('rstills').disabled = true;
    try {
      var dir = stillsDir(); fs.mkdirSync(dir, { recursive: true }); var failed = 0;
      for (var i = 0; i < clips.length; i++) {
        var c = clips[i], stem = c.name.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[\/:*?"<>|]/g, '_');
        setStatus('rstatus', 'Saving ' + (i + 1) + ' of ' + clips.length + ' — ' + stem);
        var a = await evalJsx('lcStill(' + q(c.startTicks) + ',' + q(path.join(dir, stem + '_IN')) + ')');
        var b = await evalJsx('lcStill(' + q(String(Number(c.endTicks) - frame)) + ',' + q(path.join(dir, stem + '_OUT')) + ')');
        if (a !== 'OK' || b !== 'OK') failed++;
      }
      setStatus('rstatus', (clips.length - failed) * 2 + ' stills saved to ' + dir + (failed ? ' (' + failed + ' clips failed)' : '') + '.', failed ? 'warn' : 'ok');
    } catch (e) { setStatus('rstatus', 'Stopped: ' + e.message, 'bad'); }
    state.busy = false; $('rstills').disabled = false;
  });
  $('ropen').addEventListener('click', function () { var dir = stillsDir(); if (dir) cp.execFile('/usr/bin/open', [fs.existsSync(dir) ? dir : path.dirname(dir)]); });

  // ---------------- about / setup ----------------
  $('scolumns').addEventListener('click', async function () {
    var xml; try { xml = fs.readFileSync(path.join(EXT_DIR, 'columns', 's-log.xml'), 'utf8'); } catch (e) { setStatus('astatus', 'Column file is missing. Reinstall the panel.', 'bad'); return; }
    var r = await evalJsx('lcColumns(' + q(xml) + ')');
    if (r === 'OK') setStatus('astatus', 'S-log columns applied. To sort, click the Video Info header until the arrow points down.', 'ok');
    else setStatus('astatus', 'Could not apply: ' + String(r).replace(/^ERR:/, ''), 'bad');
  });

  // ---------------- self-update (GitHub) ----------------
  function localVersion() { try { return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'version.json'), 'utf8')).version; } catch (e) { return '0.0.0'; } }
  function newer(a, b) { var x = String(a).split('.'), y = String(b).split('.'); for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d > 0; } return false; }
  function download(url, cb, hops) {
    https.get(url, { headers: { 'User-Agent': 'uai-luma-cut', 'Cache-Control': 'no-cache' } }, function (res) {
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
  $('updatebtn').addEventListener('click', function () {
    if (state.busy) return;
    var btn = $('updatebtn'); btn.disabled = true; btn.textContent = 'Updating…';
    var fail = function (msg) { btn.disabled = false; btn.textContent = 'Try again'; $('updatetext').textContent = 'Update failed: ' + msg; };
    download(ZIP_URL, function (err, buf) {
      if (err) return fail(err.message);
      try {
        var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uai-luma-cut-'));
        var zip = path.join(tmp, 'update.zip'); fs.writeFileSync(zip, buf);
        cp.execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', tmp]);
        var root = fs.readdirSync(tmp).filter(function (n) { return fs.existsSync(path.join(tmp, n, 'luma-cut', 'CSXS', 'manifest.xml')); })[0];
        if (!root) throw new Error('package is incomplete');
        var src = path.join(tmp, root, 'luma-cut');
        if (fs.readFileSync(path.join(src, 'CSXS', 'manifest.xml'), 'utf8').indexOf('com.uai.lumacut') < 0) throw new Error('wrong package');
        cp.execFileSync('/bin/cp', ['-R', src + '/.', EXT_DIR]);
        var eng = path.join(tmp, root, 'engine');
        if (fs.existsSync(eng)) { fs.mkdirSync(ENGINE_DIR, { recursive: true }); cp.execFileSync('/bin/cp', ['-R', eng + '/.', ENGINE_DIR]); }
        $('update').className = 'update done'; btn.style.display = 'none';
        $('updatetext').textContent = 'Updated to v' + localVersion() + '. Restart Premiere to use it.';
      } catch (e) { fail(e.message); }
    });
  });

  // ---------------- start ----------------
  checkUpdate();
  var last = load('lc:client');
  if (last && fs.existsSync(last)) openClient(last); else renderClient();
  window.addEventListener('focus', function () { refresh(); refreshTab(); });
  refresh();
})();
