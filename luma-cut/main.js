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
  var CM = nodeReq(path.join(EXT_DIR, 'lib', 'colormode.js'));
  var CM_TEMPLATE = path.join(EXT_DIR, 'lib', 'colormode_template.json');
  var HOME_DIR = path.join(os.homedir(), 'UAI Luma Cut');
  var MEMORY_FILE = path.join(HOME_DIR, 'grade_memory.jsonl');
  var BACKUP_DIR = path.join(HOME_DIR, 'backups');
  var PARK_FILE = path.join(HOME_DIR, 'Parking.prproj');     // blank project held open while the client project is edited
  var LOG_FILE = path.join(HOME_DIR, 'lumacut.log');
  function log(msg) { try { fs.mkdirSync(HOME_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, new Date().toISOString() + '  ' + msg + '\n'); } catch (e) {} }
  var REPO = 'agentixclaude/uai-premiere-panels';
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

  var SAMPLES_FILE = path.join(HOME_DIR, 'grade_samples.jsonl');
  var state = { bscope: load('lc:bscope') || 'all', picks: {}, info: null, client: null, clips: [], skipped: [], mode: load('lc:mode') || 'standalone', plan: null, request: null, busy: false, armed: 0, ffmpeg: SPEECH.findFfmpeg() };

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
      var orig = n.replace(/ \(\d+\)(\.[^.]+)$/, '$1');
      if (orig !== n && names.indexOf(orig) >= 0) { state.skipped.push({ file: n, why: 'duplicate of ' + orig }); return; }
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
        row.className = 'clip pick' + (p && p.flag ? ' flag' : '') + (state.picks[c.file] ? ' picked' : '');
        row.title = 'Click to pick this clip for Selected clip';
        row.addEventListener('click', function () { if (state.picks[c.file]) delete state.picks[c.file]; else state.picks[c.file] = true; renderClips(); renderTarget(); });
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
    Array.prototype.forEach.call($('bscope').children, function (x) { x.className = x.getAttribute('data-v') === state.bscope ? 'on' : ''; });
    var npick = Object.keys(state.picks).length;
    $('bscopenote').textContent = state.bscope === 'all' ? 'Re-cuts every clip and replaces the Sequences bin (grades start fresh).'
      : state.bscope === 'sequence' ? 'Re-cuts every clip in the open sequence in place. Grades on the clips stay.'
      : 'Re-cuts only the clips selected in the timeline' + (npick ? ' + ' + npick + ' picked in the list' : ' (or click rows in the list)') + '. Grades stay.';
    var b = $('build');
    var ready = c && c.rawDir && state.clips.length && projectOk && !state.busy && (state.mode === 'standalone' || claudePlanReady() || state.bscope !== 'all');
    if (state.bscope !== 'all') {
      b.className = 'primary'; b.disabled = !ready; state.armed = 0;
      b.textContent = state.bscope === 'sequence' ? 'Analyse and cut current sequence' : 'Analyse and cut selected' + (npick ? ' (+' + npick + ')' : '');
      return;
    }
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
      '\nEngine: ' + ENGINE_DIR + '\nPast review corrections: ' + MEMORY_FILE + '\nGrade samples (match these looks): ' + SAMPLES_FILE + '\nWrite luma_plan.json next to the request file.';
  }
  function writeRequest() {
    var c = state.client;
    var req = {
      version: 1, requestId: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(),
      client: c.name, ac: c.ac, clientDir: c.dir, projRel: c.projRel, rawRel: c.rawRel, engine: ENGINE_DIR, memory: MEMORY_FILE, samples: SAMPLES_FILE,
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
      try { await writeBaseline('build'); } catch (e2) {}
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
  $('build').addEventListener('click', function () { if (state.bscope === 'all') build(); else cutScoped(state.bscope); });
  Array.prototype.forEach.call($('bscope').children, function (b) {
    b.addEventListener('click', function () { if (state.busy) return; state.bscope = b.getAttribute('data-v'); store('lc:bscope', state.bscope); renderTarget(); setStatus('status', ''); });
  });

  // ---------------- scoped cut: current sequence / selected clips, in place on the timeline ----------------
  function clipByPath(p) {
    for (var i = 0; i < state.clips.length; i++) if (samePath(state.clips[i].path, p)) return state.clips[i];
    return null;
  }
  // trim for one clip: Claude's plan when it is ready (Claude mode), otherwise the audio
  async function trimFor(c) {
    if (state.mode === 'claude') {
      var p = claudePlanReady() ? planFor(c.file) : null;
      if (!p) throw new Error('Claude\'s plan has no entry for ' + c.file + '. Ask Claude first, or switch to Standalone.');
      return { inF: p['in'], outF: p.out, flag: p.flag, grade: p.grade };
    }
    var t = await analyseClip(c);
    return { inF: t.inF, outF: t.outF, flag: t.flag };
  }
  function mergePlan(entries) {
    var c = state.client, plan = readJson(c.planFile) || { version: 1, source: state.mode, client: c.name, clips: [] };
    if (!Array.isArray(plan.clips)) plan.clips = [];
    entries.forEach(function (e) {
      var i = -1; plan.clips.forEach(function (x, k) { if (x.file === e.file) i = k; });
      if (i >= 0) { var keep = plan.clips[i]; e.grade = e.grade || keep.grade; plan.clips[i] = e; } else plan.clips.push(e);
    });
    plan.updatedAt = new Date().toISOString();
    fs.mkdirSync(c.projDir, { recursive: true });
    fs.writeFileSync(c.planFile, JSON.stringify(plan, null, 1));
    loadPlan();
  }
  async function cutScoped(scope) {
    if (state.busy || !state.client) return;
    var tg = await jsx('lcCutTargets(' + q(scope) + ',' + q(JSON.stringify(Object.keys(state.picks))) + ')');
    if (tg.error) { setStatus('status', tg.error, 'warn'); return; }
    var list = tg.clips || [];
    var missing = Object.keys(state.picks).filter(function (f) { return !list.some(function (t) { return t.name === f; }); });
    if (!list.length) { setStatus('status', scope === 'selected' ? 'Select the clip in the timeline (or click it in the list) first.' + (missing.length ? ' ' + missing.join(', ') + ' is not on any sequence yet.' : '') : 'The open sequence has no clips.', 'warn'); return; }
    state.busy = true; renderTarget(); $('build').className = 'primary busy';
    var done = [], failed = [], entries = [], flagged = 0;
    try {
      for (var i = 0; i < list.length; i++) {
        var t = list[i], c = clipByPath(t.path);
        progress(i, list.length, 'Cutting ' + (i + 1) + ' of ' + list.length + ' — ' + t.name);
        if (!c) { try { var m = MP4.probe(t.path); c = { file: path.basename(t.path), path: t.path, w: m.w, h: m.h, rot: m.rot, fps: m.fps, frames: m.frames, seconds: m.seconds }; } catch (e0) { failed.push(t.name + ' (not readable)'); continue; } }
        var fps = c.fps || 29.97;
        try {
          var tr = await trimFor(c);
          var r = await jsx('lcCutApply(' + q(t.seqId) + ',' + q(t.path) + ',' + (tr.inF / fps) + ',' + ((tr.outF + 1) / fps) + ',' + q(tr.flag || '') + ')');
          if (r.error) throw new Error(String(r.error).replace(/^ERR:/, ''));
          if (tr.flag) flagged++;
          done.push(t.name);
          entries.push({ file: c.file, path: c.path, w: c.w, h: c.h, rot: c.rot, fps: c.fps, frames: c.frames, 'in': tr.inF, out: tr.outF, flag: tr.flag, grade: tr.grade });
          log('cut ' + t.name + ' in ' + t.sequence + ': ' + tr.inF + '-' + tr.outF + (tr.flag ? ' flag ' + tr.flag : ''));
        } catch (e) { failed.push(t.name + ': ' + e.message); log('cut failed ' + t.name + ': ' + e.message); }
      }
      if (entries.length) mergePlan(entries);
      await evalJsx('lcSave()');
      $('progress').firstChild.style.width = '100%';
      var msg = 'Cut ' + plural(done.length) + (done.length <= 3 && done.length ? ' (' + done.join(', ') + ')' : '') + ' in place, grades kept' +
        (flagged ? ' · ' + flagged + ' to check in Review' : '') + (failed.length ? ' · failed: ' + failed.join(' · ') : '') + '.';
      setStatus('status', msg, failed.length ? 'bad' : flagged ? 'warn' : 'ok');
      if (scope === 'selected') state.picks = {};
    } catch (e) { setStatus('status', 'Stopped: ' + e.message, 'bad'); }
    state.busy = false;
    setTimeout(function () { $('progress').hidden = true; }, 1200);
    await refresh();
  }
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
    if (!state.busy) autoColumns(state.info);
    $('ffmpegstate').textContent = state.ffmpeg ? 'ffmpeg found' : 'ffmpeg missing';
    $('ffmpegstate').className = 'chip' + (state.ffmpeg ? ' ok' : ' warn');
    var eng = fs.existsSync(path.join(ENGINE_DIR, 'luma_plan.py'));
    $('enginestate').textContent = eng ? 'Claude engine installed' : 'Claude engine missing (run install.sh)';
    $('enginestate').className = 'chip' + (eng ? ' ok' : ' warn');
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
  function refreshTab() { if (activeTab === 'grade') gradeRefresh(); if (activeTab === 'review') { reviewRefresh(); showBaseInfo(); } }
  Array.prototype.forEach.call($('tabs').children, function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

  // ---------------- grade ----------------
  // Live: Lumetri Basic (relative nudges) and Ultra Key. Apply: Color Mode > Color Shift on skin and green (file write).
  var G_FIELDS = [['hue', 'Hue Shift'], ['sat', 'Sat Shift'], ['lum', 'Lum Shift']], G_STEP = 0.5;
  var G_LUM = [['exposure', 'Exposure', 0.1], ['contrast', 'Contrast', 2], ['highlights', 'Highlights', 5], ['shadows', 'Shadows', 5],
               ['temperature', 'Temperature', 2], ['tint', 'Tint', 2], ['saturation', 'Saturation', 2]];
  var LUM_ORDER = ['temperature', 'tint', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];   // host order
  var G_KEY = [['Tolerance', 5], ['Pedestal', 5], ['Choke', 2], ['Soften', 2], ['Spill', 5]];
  var KEY_DEFAULT = [34, 133, 80];        // a typical lit green after the house grade, used only without ffmpeg
  var PRESETS = {
    over:   { label: 'Over-exposed',  lum: { exposure: -0.5, highlights: -15, whites: -10 }, skin: { hue: 3.5, sat: 3, lum: -3 }, green: { sat: 5, lum: -10 } },
    normal: { label: 'Normal',        lum: null,                                             skin: { hue: 3.5, sat: 3, lum: 0 },  green: { sat: 5, lum: 0 } },
    under:  { label: 'Under-exposed', lum: { exposure: 0.5, shadows: 15, blacks: 5 },        skin: { hue: 3.5, sat: 3, lum: 3 },  green: { sat: 5, lum: 10 } }
  };
  var grade = { scope: 'selected', info: null, values: {}, shown: null, edits: { skin: {}, green: {} }, busy: false, lum: null, key: null };
  function plural(n) { return n + (n === 1 ? ' clip' : ' clips'); }
  function r2(v) { return Math.round(Number(v) * 100) / 100; }
  function sgn(v) { v = r2(v); return (v > 0 ? '+' : '') + v; }
  function keyedOn() { return !!(grade.key && grade.key.keyed); }
  function gValue(part, k) {
    var e = grade.edits[part][k];
    if (e !== undefined) return e;
    return grade.shown ? grade.shown[part][k] : 0;
  }
  function gDirty() { return Object.keys(grade.edits.skin).length + (keyedOn() ? 0 : Object.keys(grade.edits.green).length); }
  function gRender() {
    ['skin', 'green'].forEach(function (part) {
      G_FIELDS.forEach(function (f) {
        var inp = $('gv-' + part + '-' + f[0]), v = gValue(part, f[0]);
        if (document.activeElement !== inp) inp.value = (v > 0 ? '+' : '') + r2(v).toFixed(2);
        inp.className = 'v' + (grade.edits[part][f[0]] !== undefined ? ' changed' : '');
      });
    });
    var lv = grade.lum && grade.lum.values, lumOn = !!(grade.lum && grade.lum.graded) && !grade.busy;
    G_LUM.forEach(function (f) {
      $('gl-' + f[0]).textContent = lv && lv[f[0]] !== null && lv[f[0]] !== undefined ? r2(lv[f[0]]) : '–';
      $('gl-' + f[0]).parentNode.querySelectorAll('button').forEach(function (b) { b.disabled = !lumOn; });
    });
    var k = grade.key || { count: 0, keyed: 0 }, kv = k.values;
    $('gkey').className = 'switch end' + (k.keyed ? (k.keyed < k.count ? ' on mixed' : ' on') : '');
    $('gkey').disabled = grade.busy || !k.count;
    $('gkey').lastChild.textContent = k.keyed ? 'Green removed' + (k.keyed < k.count ? ' · ' + k.keyed + '/' + k.count : '') : 'Remove green';
    $('ggreen').hidden = !!k.keyed; $('gkeyrows').hidden = !k.keyed; $('gkeynote').hidden = !k.keyed;
    G_KEY.forEach(function (f) {
      $('gk-' + f[0]).textContent = kv && kv[f[0]] !== null && kv[f[0]] !== undefined ? r2(kv[f[0]]) : '–';
      $('gk-' + f[0]).parentNode.querySelectorAll('button').forEach(function (b) { b.disabled = grade.busy; });
    });
    Array.prototype.forEach.call($('gpresets').children, function (b) { b.disabled = grade.busy || !(grade.info && grade.info.names && grade.info.names.length); });
    var n = grade.info && grade.info.names ? grade.info.names.length : 0, d = gDirty();
    $('gapply').disabled = !n || !d || grade.busy;
    $('gapply').textContent = d ? 'Apply ' + d + (d === 1 ? ' Color Shift change' : ' Color Shift changes') + ' to ' + plural(n) : 'Apply';
    $('greset').disabled = !Object.keys(grade.edits.skin).length && !Object.keys(grade.edits.green).length;
  }
  // Color Shift rows (Apply)
  ['skin', 'green'].forEach(function (part) {
    G_FIELDS.forEach(function (f) {
      var row = document.createElement('div'); row.className = 'prow';
      row.innerHTML = '<span></span><input type="text" inputmode="decimal"><button></button><button></button>';
      row.children[0].textContent = f[1];
      var inp = row.children[1]; inp.id = 'gv-' + part + '-' + f[0];
      var set = function (v) { if (!isFinite(v)) return; v = Math.max(-100, Math.min(100, r2(v))); grade.edits[part][f[0]] = v; gRender(); };
      inp.addEventListener('change', function () { set(parseFloat(inp.value)); });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') inp.blur(); });
      [-1, 1].forEach(function (sign, k) {
        var b = row.children[2 + k]; b.textContent = sign > 0 ? '+' : '−';
        b.title = (sign > 0 ? '+' : '−') + G_STEP;
        b.addEventListener('click', function () { set(gValue(part, f[0]) + sign * G_STEP); });
      });
      $(part === 'skin' ? 'gskin' : 'ggreen').appendChild(row);
    });
  });
  // live rows: value shown is the first clip's; a step moves every clip in scope by the same amount
  function liveRow(box, id, label, step, onStep) {
    var row = document.createElement('div'); row.className = 'prow live';
    row.innerHTML = '<span></span><span class="v"></span><button>−</button><button>+</button>';
    row.children[0].textContent = label; row.children[1].id = id; row.children[1].textContent = '–';
    [-1, 1].forEach(function (sign, k) {
      var b = row.children[2 + k]; b.title = (sign > 0 ? '+' : '−') + step + ' on every clip in scope';
      b.addEventListener('click', function () { onStep(sign * step); });
    });
    $(box).appendChild(row);
  }
  var liveBusy = false;
  async function lumNudge(deltas) {
    if (liveBusy || grade.busy) return;
    liveBusy = true;
    var csv = LUM_ORDER.map(function (k) { return deltas[k] === undefined ? 'x' : deltas[k]; }).join(',');
    var r = await jsx('lcNudge(' + q(grade.scope) + ',' + q(csv) + ')');
    liveBusy = false;
    if (r.error) { setStatus('gstatus', r.error, 'bad'); return null; }
    grade.lum = r; gRender(); return r;
  }
  G_LUM.forEach(function (f) {
    liveRow('glum', 'gl-' + f[0], f[1], f[2], function (d) {
      var o = {}; o[f[0]] = d;
      lumNudge(o).then(function (r) { if (r) setStatus('gstatus', f[1] + ' ' + sgn(d) + ' on ' + plural(r.graded) + '.'); });
    });
  });
  G_KEY.forEach(function (f) {
    liveRow('gkeyrows', 'gk-' + f[0], f[0], f[1], async function (d) {
      if (liveBusy || grade.busy) return;
      liveBusy = true;
      var r = await jsx('lcKeySet(' + q(grade.scope) + ',' + q(f[0]) + ',' + d + ')');
      liveBusy = false;
      if (r.error) { setStatus('gstatus', r.error, 'bad'); return; }
      grade.key = r; gRender(); setStatus('gstatus', f[0] + ' ' + sgn(d) + ' on ' + plural(r.keyed) + '.');
    });
  });

  // Read Color Shift from the project as last saved. Never saves: saving on every look made Premiere save over and over
  // (save -> panel regains focus -> refresh -> save ...). Cached by file time, so returning to the panel costs nothing.
  var cmCache = { file: '', mtime: 0, values: {} };
  function readColorShift(projectPath) {
    var m = fs.statSync(projectPath).mtimeMs;
    if (cmCache.file === projectPath && cmCache.mtime === m) return cmCache.values;
    var values = CM.readAll(CM.load(projectPath));
    cmCache = { file: projectPath, mtime: m, values: values };
    return values;
  }
  async function gradeRefresh() {
    if (grade.busy) return;
    var info = await jsx('lcTargetNames(' + q(grade.scope) + ')');
    grade.info = info.error ? null : info;
    if (info.error) { $('gtarget').textContent = info.error; grade.lum = null; grade.key = null; gRender(); return; }
    grade.lum = await jsx('lcLumState(' + q(grade.scope) + ')');
    grade.key = await jsx('lcKeyState(' + q(grade.scope) + ')');
    if (grade.lum.error) grade.lum = null;
    if (grade.key.error) grade.key = null;
    try { grade.values = readColorShift(info.projectPath); } catch (e) { grade.values = {}; }
    var names = info.names || [];
    grade.shown = names.length && grade.values[names[0]] ? grade.values[names[0]] : { skin: { hue: 0, sat: 0, lum: 0 }, green: { hue: 0, sat: 0, lum: 0 } };
    var t = !names.length ? (grade.scope === 'selected' ? 'Select clips in the timeline, then press Refresh.' : 'No enabled clips on V1.')
      : plural(names.length) + (info.sequences > 1 ? ' in ' + info.sequences + ' sequences' : '') + ' — ' + (names.length > 1 ? 'showing ' + names[0] : names[0]);
    var without = names.filter(function (n) { return grade.values[n] && !grade.values[n].hasColorMode; }).length;
    if (without) t += ' · ' + without + ' without Color Mode yet (added on Apply)';
    $('gtarget').textContent = t;
    gRender();
  }
  Array.prototype.forEach.call($('gscope').children, function (b) {
    b.addEventListener('click', function () {
      if (grade.busy) return;
      Array.prototype.forEach.call($('gscope').children, function (x) { x.className = x === b ? 'on' : ''; });
      grade.scope = b.getAttribute('data-v'); gradeRefresh();
    });
  });
  // exposure presets: Lumetri correction now (live), Color Shift values filled for Apply
  Array.prototype.forEach.call($('gpresets').children, function (b) {
    b.addEventListener('click', async function () {
      var p = PRESETS[b.getAttribute('data-v')]; if (!p || grade.busy) return;
      var r = p.lum ? await lumNudge(p.lum) : null;
      grade.edits.skin = JSON.parse(JSON.stringify(p.skin));
      if (!keyedOn()) grade.edits.green = JSON.parse(JSON.stringify(p.green));
      gRender();
      setStatus('gstatus', p.label + ': ' + (r ? 'Lumetri corrected on ' + plural(r.graded) + ' (press again for more). ' : '') + 'Skin' + (keyedOn() ? '' : ' and green') + ' Color Shift filled — press Apply.', 'ok');
    });
  });

  // ---- one-click green removal (Ultra Key, key colour sampled per clip) ----
  var KEY_TMP = path.join(os.tmpdir(), 'uai_lumacut_key');
  function sampleFrame(png) {
    return new Promise(function (resolve) {
      if (!state.ffmpeg) return resolve(null);
      cp.execFile(state.ffmpeg, ['-v', 'error', '-i', png, '-vf', 'scale=64:36:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 1 << 20 }, function (err, out) {
          if (err || !out || out.length < 64 * 36 * 3) return resolve(null);
          var px = [];
          for (var y = 0; y < 22; y++) for (var x = 0; x < 64; x++) {
            if (y > 3 && x > 4 && x < 59) continue;                    // top band + the two upper sides: the backdrop, not the person
            var i = (y * 64 + x) * 3; px.push([out[i], out[i + 1], out[i + 2]]);
          }
          var green = px.filter(function (c) { return c[1] > 60 && c[1] > c[0] * 1.3 && c[1] > c[2] * 1.15; });
          if (green.length < px.length * 0.6) return resolve({ green: false });
          var med = [0, 1, 2].map(function (k) { var v = green.map(function (c) { return c[k]; }).sort(function (a, b) { return a - b; }); return v[v.length >> 1]; });
          resolve({ green: true, color: med });
        });
    });
  }
  async function keyOn() {
    var info = grade.info; if (!info) return;
    var targets = await jsx('lcKeyTargets(' + q(grade.scope) + ')');
    if (targets.error) { setStatus('gstatus', targets.error, 'bad'); return; }
    var todo = targets.filter(function (t) { return !t.keyed; });
    if (!todo.length) { setStatus('gstatus', 'Every clip in scope is already keyed.', 'ok'); return; }
    if (!state.ffmpeg && grade.scope !== 'selected') { setStatus('gstatus', 'ffmpeg is needed to find the green-screen clips. Use Selected, or install it with install.sh.', 'warn'); return; }
    var params = keyedOn() && grade.key.values ? G_KEY.map(function (f) { return grade.key.values[f[0]]; }).join(',') : '';
    fs.mkdirSync(KEY_TMP, { recursive: true });
    var keyed = 0, skipped = 0, failed = 0;
    for (var i = 0; i < todo.length; i++) {
      var t = todo[i]; setStatus('gstatus', 'Checking ' + (i + 1) + ' of ' + todo.length + ' — ' + t.name);
      var color = KEY_DEFAULT;
      if (state.ffmpeg) {
        var base = path.join(KEY_TMP, 'k' + i);
        var st = await evalJsx('lcStillIn(' + q(t.seqId) + ',' + q(t.ticks) + ',' + q(base) + ')');
        var png = [base + '.png', base].filter(function (f) { return fs.existsSync(f); })[0];
        var smp = /^OK/.test(st) && png ? await sampleFrame(png) : null;
        try { if (png) fs.unlinkSync(png); } catch (e) {}
        if (!smp) { failed++; continue; }
        if (!smp.green) { skipped++; continue; }
        color = smp.color;
      }
      var r = await evalJsx('lcKeyAdd(' + q(t.seqId) + ',' + t.index + ',' + color[0] + ',' + color[1] + ',' + color[2] + ',' + q(params) + ')');
      if (r === 'OK') keyed++; else { failed++; log('key ' + t.name + ': ' + r); }
    }
    await evalJsx('lcOpenSeq(' + q(info.sequenceId) + ')');
    await evalJsx('lcGoto(' + q(info.position) + ')');
    setStatus('gstatus', 'Green removed on ' + plural(keyed) + (skipped ? ' · ' + skipped + ' not green-screen, left alone' : '') + (failed ? ' · ' + failed + ' could not be checked' : '') + '. Tune the key below; it updates live.', failed ? 'warn' : 'ok');
  }
  $('gkey').addEventListener('click', async function () {
    if (grade.busy || liveBusy) return;
    grade.busy = true; gRender();
    try {
      if (keyedOn()) {
        var info = grade.info, r = await evalJsx('lcKeyRemove(' + q(grade.scope) + ')');
        if (info) { await evalJsx('lcOpenSeq(' + q(info.sequenceId) + ')'); await evalJsx('lcGoto(' + q(info.position) + ')'); }
        setStatus('gstatus', /^OK:/.test(r) ? 'Key removed from ' + plural(parseInt(r.slice(3), 10)) + '.' : 'Could not remove the key: ' + String(r).replace(/^ERR:/, ''), /^OK:/.test(r) ? 'ok' : 'bad');
      } else await keyOn();
    } catch (e) { setStatus('gstatus', 'Stopped: ' + e.message, 'bad'); }
    grade.busy = false;
    await gradeRefresh();
  });

  $('greset').addEventListener('click', function () { grade.edits = { skin: {}, green: {} }; gRender(); setStatus('gstatus', ''); });
  $('gcopy').addEventListener('click', async function () {
    var info = await jsx('lcTargetNames("selected")');
    if (info.error || !info.names.length) { setStatus('gstatus', info.error || 'Select one clip in the timeline first.', 'warn'); return; }
    try { await evalJsx('lcSave()'); grade.values = readColorShift(info.projectPath); } catch (e) { setStatus('gstatus', 'Could not read the project: ' + e.message, 'bad'); return; }
    var v = grade.values[info.names[0]]; if (!v) { setStatus('gstatus', info.names[0] + ' has no S-Log grade.', 'warn'); return; }
    grade.edits = { skin: JSON.parse(JSON.stringify(v.skin)), green: JSON.parse(JSON.stringify(v.green)) };
    $('gclip').textContent = 'Copied Color Shift from ' + info.names[0] + '. Pick where it goes, then Apply.';
    gRender();
  });
  function backupProject(file) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    var stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    var dest = path.join(BACKUP_DIR, path.basename(file, '.prproj') + '_' + stamp + '.prproj');
    fs.copyFileSync(file, dest);
    var all = fs.readdirSync(BACKUP_DIR).filter(function (n) { return n.indexOf(path.basename(file, '.prproj') + '_') === 0; }).sort();
    while (all.length > 10) { try { fs.unlinkSync(path.join(BACKUP_DIR, all.shift())); } catch (e) {} }
    return dest;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // The job is written to disk before the project closes, so if Premiere ever unloads the panel mid-way,
  // the panel finishes it (write + reopen) the next time it loads.
  var PENDING_FILE = path.join(HOME_DIR, 'pending_apply.json');
  async function finishApply(job) {
    var report = null, err = null;
    try {
      if (!job.written) {
        await wait(800);
        job.backup = backupProject(job.file);
        fs.writeFileSync(PENDING_FILE, JSON.stringify(job));
        setStatus('gstatus', 'Writing Color Shift…');
        var tpl = JSON.parse(fs.readFileSync(CM_TEMPLATE, 'utf8'));
        report = CM.applyAndSave(job.file, job.edits, tpl);
        log('written: ' + report.join(' | '));
        job.written = true; job.report = report;
        fs.writeFileSync(PENDING_FILE, JSON.stringify(job));
      } else report = job.report || [];
    } catch (e) { err = e; log('error: ' + (e.stack || e.message)); }
    setStatus('gstatus', 'Reopening…');
    var o = await evalJsx('lcReopen(' + q(job.file) + ',' + q(job.sequenceId) + ',' + q(job.position) + ',' + q(PARK_FILE) + ')');
    log('reopen: ' + o);
    if (o !== 'OK' && job.written && job.backup && fs.existsSync(job.backup)) {
      // Premiere refused the written file: put the backup back and open that, so the project is never left closed
      fs.copyFileSync(job.backup, job.file);
      o = await evalJsx('lcReopen(' + q(job.file) + ',' + q(job.sequenceId) + ',' + q(job.position) + ',' + q(PARK_FILE) + ')');
      log('restored backup, reopen: ' + o);
      if (!err) err = new Error('Premiere would not open the written project, so the backup was put back. Nothing changed.');
    }
    if (o === 'OK') { try { fs.unlinkSync(PENDING_FILE); } catch (e) {} }
    return { report: report, err: err, reopened: o === 'OK' };
  }
  $('gapply').addEventListener('click', async function () {
    if (grade.busy || !gDirty()) return;
    var info = await jsx('lcTargetNames(' + q(grade.scope) + ')');
    if (info.error || !info.names.length) { setStatus('gstatus', info.error || 'No clips to apply to.', 'warn'); return; }
    if (!fs.existsSync(CM_TEMPLATE)) { setStatus('gstatus', 'Color Mode template is missing. Reinstall the panel.', 'bad'); return; }
    var edits = {};
    info.names.forEach(function (n) { edits[n] = { skin: grade.edits.skin, green: keyedOn() ? {} : grade.edits.green }; });
    var job = { file: info.projectPath, sequenceId: info.sequenceId, position: info.position, edits: edits, names: info.names, createdAt: new Date().toISOString() };
    grade.busy = true; gRender(); $('gapply').className = 'primary busy'; state.busy = true;
    var res;
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.writeFileSync(PENDING_FILE, JSON.stringify(job));
      log('apply ' + JSON.stringify(grade.edits) + ' to ' + info.names.join(', ') + ' in ' + job.file);
      setStatus('gstatus', 'Saving and parking the project…');
      var c = await evalJsx('lcCloseForEdit(' + q(PARK_FILE) + ')');
      log('close: ' + c);
      if (!/^OK/.test(c)) throw new Error(String(c).replace(/^ERR:/, ''));
      res = await finishApply(job);
    } catch (e) {
      log('error: ' + e.message);
      try { fs.unlinkSync(PENDING_FILE); } catch (e2) {}
      var o = await evalJsx('lcReopen(' + q(job.file) + ',' + q(job.sequenceId) + ',' + q(job.position) + ',' + q(PARK_FILE) + ')');
      res = { err: e, reopened: o === 'OK', report: null };
    }
    grade.busy = false; state.busy = false; $('gapply').className = 'primary';
    if (res.err) setStatus('gstatus', 'Not applied: ' + res.err.message + (res.reopened ? '' : ' Reopen the project from File > Open Recent.'), 'bad');
    else if (!res.reopened) setStatus('gstatus', 'Written, but Premiere did not reopen the project. Open it from File > Open Recent.', 'warn');
    else {
      setStatus('gstatus', 'Applied to ' + plural(info.names.length) + '. Check the look; Review ✓ records it.', 'ok');
      grade.edits = { skin: {}, green: {} };
    }
    await refresh(); gradeRefresh();
  });
  // finish an Apply that was cut off (panel unloaded while the project was closed)
  async function resumePendingApply() {
    var job = readJson(PENDING_FILE); if (!job || !job.file) return;
    if (Date.now() - new Date(job.createdAt).getTime() > 30 * 60 * 1000) { try { fs.unlinkSync(PENDING_FILE); } catch (e) {} return; }
    var open = await evalJsx('lcOpenIndex(' + q(job.file) + ')');
    if (Number(open) >= 0) { log('pending job dropped: project is open again'); try { fs.unlinkSync(PENDING_FILE); } catch (e) {} return; }
    log('resuming pending apply');
    grade.busy = true; state.busy = true;
    var res = await finishApply(job);
    grade.busy = false; state.busy = false;
    setStatus('status', res.err ? 'An interrupted Grade Apply could not be finished: ' + res.err.message : 'Finished the interrupted Grade Apply on ' + plural(job.names.length) + '.', res.err ? 'bad' : 'ok');
  }

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
  // Images go to the client's Final Output / Stills (PNG)
  function finalOutputDir() {
    if (state.client) return path.join(state.client.dir, state.client.outRel);
    if (!state.info || !state.info.open) return '';
    var clientDir = path.dirname(path.dirname(state.info.projectPath));
    return path.join(clientDir, subdir(clientDir, /^final[ _-]?outputs?$/i) || 'Final Output');
  }
  function stillsDir() { var f = finalOutputDir(); return f ? path.join(f, 'Stills') : ''; }
  function stemOf(name) { return String(name).replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[\/:*?"<>|]/g, '_'); }
  async function saveImages(clips, frame, suffix) {
    var dir = stillsDir(); fs.mkdirSync(dir, { recursive: true });
    var failed = 0, n = 0;
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i], stem = stemOf(c.name) + (suffix || '');
      setStatus('rstatus', 'Saving ' + (i + 1) + ' of ' + clips.length + ' — ' + stemOf(c.name));
      var a = await evalJsx('lcStill(' + q(c.startTicks) + ',' + q(path.join(dir, stem + '_IN')) + ')');
      var b = await evalJsx('lcStill(' + q(String(Number(c.endTicks) - frame)) + ',' + q(path.join(dir, stem + '_OUT')) + ')');
      if (!/^OK/.test(a) || !/^OK/.test(b)) failed++; else n += 2;
    }
    return { dir: dir, saved: n, failed: failed };
  }
  $('rstills').addEventListener('click', async function () {
    if (state.busy) return;
    await reviewRefresh();
    var d = review.data; if (!d) return;
    var flagged = {};
    d.markers.filter(isFlag).forEach(function (mk) { flagged[mk.name.replace(/^(IN|OUT) /, '')] = true; });
    var seen = {}, clips = d.clips.filter(function (c) { if (seen[c.name]) return false; seen[c.name] = true; return review.sscope === 'all' || (review.sscope === 'selected' ? c.selected : flagged[c.name]); });
    if (!clips.length) { setStatus('rstatus', review.sscope === 'selected' ? 'Select clips in the timeline first.' : 'No matching clips.', 'warn'); return; }
    state.busy = true; $('rstills').disabled = true;
    try {
      var r = await saveImages(clips, Number(d.timebase), '');
      setStatus('rstatus', r.saved + ' images saved to Final Output / Stills' + (r.failed ? ' (' + r.failed + ' clips failed)' : '') + '.', r.failed ? 'warn' : 'ok');
    } catch (e) { setStatus('rstatus', 'Stopped: ' + e.message, 'bad'); }
    state.busy = false; $('rstills').disabled = false;
  });
  // Grade sample: the clip's finished grade (Lumetri + skin / green Color Shift) + an image, kept as a reference for future grading
  $('rsample').addEventListener('click', async function () {
    if (state.busy) return;
    await reviewRefresh();
    var d = review.data; if (!d) return;
    var seen = {}, clips = d.clips.filter(function (c) { if (seen[c.name]) return false; seen[c.name] = true; return review.sscope === 'all' || (review.sscope === 'selected' ? c.selected : flagsFor(c.name).length); });
    if (!clips.length) { setStatus('rstatus', review.sscope === 'selected' ? 'Select the graded clip in the timeline first.' : 'No matching clips.', 'warn'); return; }
    state.busy = true; $('rsample').disabled = true;
    try {
      var info = await jsx('lcInfo()'); state.info = info;
      var all = await snapshot(), frame = Number(d.timebase), dir = stillsDir(), n = 0;
      fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(HOME_DIR, { recursive: true });
      for (var i = 0; i < clips.length; i++) {
        var c = clips[i], stem = stemOf(c.name) + '_SAMPLE';
        setStatus('rstatus', 'Sampling ' + (i + 1) + ' of ' + clips.length + ' — ' + stemOf(c.name));
        var mid = String(Math.round((Number(c.startTicks) + Number(c.endTicks)) / 2 / frame) * frame);
        var st = await evalJsx('lcStill(' + q(mid) + ',' + q(path.join(dir, stem)) + ')');
        var img = [stem + '.png', stem + '.jpg', stem].map(function (f) { return path.join(dir, f); }).filter(function (f) { return fs.existsSync(f); })[0] || '';
        var g = all[c.name] || {}, cam = (stemOf(c.name).match(/^([A-Za-z]+\d*)/) || ['', ''])[1].toUpperCase();
        var entry = { date: new Date().toISOString(), client: state.client ? state.client.name : path.basename(info.projectPath, '.prproj').replace(/_GRADED$/, ''),
          ac: state.client ? state.client.ac : false, clip: c.name, camera: cam, sequence: d.sequence, lumetri: g.lumetri || null,
          skin: g.skin || null, green: g.green || null, image: img, note: $('rnote').value.trim() || 'graded by hand, kept as a sample' };
        fs.appendFileSync(SAMPLES_FILE, JSON.stringify(entry) + '\n');
        if (/^OK/.test(st)) n++;
        log('sample ' + c.name + ' -> ' + SAMPLES_FILE);
      }
      setStatus('rstatus', plural(clips.length) + ' kept as grade samples (' + n + ' images in Final Output / Stills). Claude reads them on the next client.', 'ok');
    } catch (e) { setStatus('rstatus', 'Could not take the sample: ' + e.message, 'bad'); }
    state.busy = false; $('rsample').disabled = false;
  });
  $('ropen').addEventListener('click', function () { var dir = stillsDir(); if (dir) cp.execFile('/usr/bin/open', [fs.existsSync(dir) ? dir : path.dirname(dir)]); });

  // ---------------- Review ✓: what changed after the build / last review, remembered for next time ----------------
  var LUM_NAMES = { temperature: 'Temperature', tint: 'Tint', saturation: 'Saturation', exposure: 'Exposure', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks' };
  var rv = { changes: null, current: null };
  function baselineFile() { return state.info && state.info.open ? path.join(path.dirname(state.info.projectPath), 'luma_baseline.json') : ''; }
  function reviewLogFile() { return state.info && state.info.open ? path.join(path.dirname(state.info.projectPath), 'luma_review_log.json') : ''; }
  async function snapshot() {
    await evalJsx('lcSave()');
    var lum = await jsx('lcAllGrades()');
    if (lum.error) throw new Error(lum.error);
    var cm = {}; try { cm = CM.readAll(CM.load(state.info.projectPath)); } catch (e) {}
    var clips = {};
    Object.keys(lum).forEach(function (n) { clips[n] = { lumetri: lum[n], skin: cm[n] ? cm[n].skin : { hue: 0, sat: 0, lum: 0 }, green: cm[n] ? cm[n].green : { hue: 0, sat: 0, lum: 0 } }; });
    return clips;
  }
  async function writeBaseline(by) {
    var info = await jsx('lcInfo()'); if (!info.open) return;
    state.info = info;
    var clips = await snapshot();
    fs.writeFileSync(baselineFile(), JSON.stringify({ updatedAt: new Date().toISOString(), by: by, clips: clips }, null, 1));
  }
  function diff(base, cur) {
    var out = [];
    Object.keys(cur).forEach(function (n) {
      var b = base[n], c = cur[n], items = [];
      if (!b) return;
      Object.keys(LUM_NAMES).forEach(function (k) {
        var x = b.lumetri ? b.lumetri[k] : null, y = c.lumetri[k];
        if (x !== null && x !== undefined && y !== null && y !== undefined && Math.abs(y - x) >= 0.05) items.push({ area: 'Best grade', field: LUM_NAMES[k], from: x, to: y });
      });
      ['skin', 'green'].forEach(function (part) {
        ['hue', 'sat', 'lum'].forEach(function (k) {
          var x = (b[part] || {})[k] || 0, y = (c[part] || {})[k] || 0;
          if (Math.abs(y - x) >= 0.05) items.push({ area: part === 'skin' ? 'Skin' : 'Green screen', field: k.charAt(0).toUpperCase() + k.slice(1) + ' Shift', from: x, to: y });
        });
      });
      if (items.length) out.push({ clip: n, camera: n.replace(/\.[^.]+$/, '').match(/^([A-Za-z]+\d*)/) ? n.replace(/\.[^.]+$/, '').match(/^([A-Za-z]+\d*)/)[1].toUpperCase() : '', items: items });
    });
    return out;
  }
  function sign(v) { v = Math.round(v * 100) / 100; return (v > 0 ? '+' : '') + v; }
  function showBaseInfo() {
    var f = baselineFile(), b = f ? readJson(f) : null;
    $('rbase').textContent = b ? 'since ' + (b.by === 'review' ? 'last review' : 'build') + ' · ' + new Date(b.updatedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not tracking yet';
    $('rbaseline').hidden = !!b || !(state.info && state.info.open);
  }
  $('rbaseline').addEventListener('click', async function () {
    try { await writeBaseline('review'); setStatus('rstatus', 'Tracking changes from now on.', 'ok'); } catch (e) { setStatus('rstatus', 'Could not start tracking: ' + e.message, 'bad'); }
    showBaseInfo();
  });
  $('rcheck').addEventListener('click', async function () {
    if (state.busy) return;
    var info = await jsx('lcInfo()'); if (!info.open) { setStatus('rstatus', 'Open the client project first.', 'warn'); return; }
    state.info = info; showBaseInfo();
    var base = readJson(baselineFile());
    if (!base) { setStatus('rstatus', 'Nothing to compare yet. Press Start tracking from here, then make your changes.', 'warn'); return; }
    setStatus('rstatus', 'Reading the grade…');
    try { rv.current = await snapshot(); } catch (e) { setStatus('rstatus', 'Could not read the grade: ' + e.message, 'bad'); return; }
    rv.changes = diff(base.clips, rv.current);
    var box = $('rchanges'); box.innerHTML = '';
    if (!rv.changes.length) {
      box.hidden = true; $('rnote').hidden = true; $('rconfirmrow').hidden = true;
      setStatus('rstatus', 'No changes since the ' + (base.by === 'review' ? 'last review' : 'build') + '.', 'ok'); return;
    }
    rv.changes.forEach(function (c) {
      var row = document.createElement('div'); row.className = 'c';
      row.innerHTML = '<span class="n"></span><span class="muted"></span><span class="d"></span>';
      row.children[0].textContent = c.clip; row.children[1].textContent = c.items.length + (c.items.length === 1 ? ' change' : ' changes');
      row.children[2].innerHTML = c.items.map(function (it) { return it.area + ' ' + it.field + ' <b>' + sign(it.to - it.from) + '</b> (' + sign(it.from) + ' → ' + sign(it.to) + ')'; }).join(' · ');
      box.appendChild(row);
    });
    box.hidden = false; $('rnote').hidden = false; $('rconfirmrow').hidden = false;
    var total = rv.changes.reduce(function (a, c) { return a + c.items.length; }, 0);
    setStatus('rstatus', total + ' changes on ' + plural(rv.changes.length) + '. Add a note, then confirm.');
  });
  $('rconfirm').addEventListener('click', async function () {
    if (!rv.changes || !rv.changes.length || state.busy) return;
    var entry = {
      date: new Date().toISOString(), client: state.client ? state.client.name : path.basename(state.info.projectPath, '.prproj').replace(/_GRADED$/, ''),
      ac: state.client ? state.client.ac : /(^|[^A-Za-z])AC\s*#?\s*\d+/i.test(state.info.projectPath), project: state.info.projectPath,
      reviewer: os.userInfo().username, note: $('rnote').value.trim(), changes: rv.changes
    };
    try {
      var log = readJson(reviewLogFile()) || []; log.push(entry);
      fs.writeFileSync(reviewLogFile(), JSON.stringify(log, null, 1));
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n');
      fs.writeFileSync(baselineFile(), JSON.stringify({ updatedAt: entry.date, by: 'review', clips: rv.current }, null, 1));
    } catch (e) { setStatus('rstatus', 'Could not save the review: ' + e.message, 'bad'); return; }
    var msg = 'Review saved: ' + plural(rv.changes.length) + ', remembered for the next client.';
    if ($('rimages').checked) {
      await reviewRefresh();
      var d = review.data, changed = {};
      rv.changes.forEach(function (c) { changed[c.clip] = true; });
      var seen = {}, clips = d ? d.clips.filter(function (c) { if (seen[c.name] || !changed[c.name]) return false; seen[c.name] = true; return true; }) : [];
      if (clips.length) {
        state.busy = true;
        try { var r = await saveImages(clips, Number(d.timebase), '_review'); msg += ' ' + r.saved + ' images in Final Output / Stills.'; } catch (e) {}
        state.busy = false;
      }
      if (d && clips.length < rv.changes.length) msg += ' Images only for ' + d.sequence + '.';
    }
    rv.changes = null; $('rchanges').hidden = true; $('rnote').hidden = true; $('rnote').value = ''; $('rconfirmrow').hidden = true;
    setStatus('rstatus', msg, 'ok'); showBaseInfo();
  });

  // ---------------- project panel: S-log columns by default ----------------
  // Set once per project per session when a client project is open (the build sets them too). No button, no save.
  var colsDone = {};
  async function autoColumns(info) {
    if (!info || !info.open || colsDone[info.projectPath]) return;
    var client = state.client && String(info.projectPath).toLowerCase().indexOf(state.client.dir.toLowerCase() + '/') === 0;
    if (!client && !info.hasSequencesBin) return;
    colsDone[info.projectPath] = true;
    var xml; try { xml = fs.readFileSync(path.join(EXT_DIR, 'columns', 's-log.xml'), 'utf8'); } catch (e) { return; }
    var r = await evalJsx('lcColumns(' + q(xml) + ')');
    if (r !== 'OK') delete colsDone[info.projectPath];      // try again on the next refresh
  }

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
  var lastFocus = 0;     // one re-read per return to the panel; never while building, applying or saving images
  resumePendingApply();
  window.addEventListener('focus', function () {
    var t = Date.now();
    if (state.busy || grade.busy || t - lastFocus < 1500) return;
    lastFocus = t; refresh(); refreshTab();
  });
  refresh();
})();
