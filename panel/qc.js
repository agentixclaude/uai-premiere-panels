/* UAI Smart Export — Auto QC, Review pack, Social copy (1.10.0). Uses ffmpeg/ffprobe from Homebrew.
   QC per file: start/end frames (black or frozen), loudness (EBU R128 integrated), duration vs timeline,
   codec / frame size / frame rate / size band. Review pack: 720p copy under N MB, contact sheet (first/middle/last),
   cover PNG. Social: 1080 wide, 8 Mbps, fast start, loudness normalised to the target. */
(function (root) {
  var nodeReq = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var fs = nodeReq('fs'), path = nodeReq('path'), cp = nodeReq('child_process');
  function find(name) {
    return ['/opt/homebrew/bin/', '/usr/local/bin/', '/usr/bin/'].map(function (d) { return d + name; })
      .filter(function (f) { try { return fs.existsSync(f); } catch (e) { return false; } })[0] || null;
  }
  var FFPROBE = find('ffprobe'), FFMPEG = find('ffmpeg');

  function run(bin, args, timeout) {
    return new Promise(function (resolve) {
      if (!bin) return resolve({ code: -1, out: '', err: 'missing' });
      cp.execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeout || 0 }, function (e, out, err) {
        resolve({ code: e ? (e.code || 1) : 0, out: String(out || ''), err: String(err || '') });
      });
    });
  }
  function ratioNum(r) { var p = String(r || '').split('/'); return p.length === 2 && +p[1] ? +p[0] / +p[1] : +r || 0; }

  async function probe(file) {
    var r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration,size',
      '-of', 'json', file], 60000);
    if (r.code) return { error: r.code === -1 ? 'ffprobe missing' : 'unreadable (still encoding?)' };
    try {
      var j = JSON.parse(r.out), v = null, a = null;
      (j.streams || []).forEach(function (s) { if (s.codec_type === 'video' && !v) v = s; if (s.codec_type === 'audio' && !a) a = s; });
      if (!v) return { error: 'no video stream' };
      return { codec: v.codec_name, w: v.width, h: v.height, fps: ratioNum(v.avg_frame_rate) || ratioNum(v.r_frame_rate),
               dur: parseFloat((j.format || {}).duration) || 0, bytes: parseInt((j.format || {}).size, 10) || 0, audio: !!a };
    } catch (e) { return { error: 'unreadable' }; }
  }

  // black / frozen picture in the first and the last second
  async function edges(file, dur, fps) {
    var vf = 'scale=320:-2,blackdetect=d=0:pix_th=0.10:pic_th=0.98,freezedetect=n=-60dB:d=0.8';
    var seg = Math.min(1, Math.max(0.2, dur / 2));
    var one = async function (head) {
      var args = ['-hide_banner', '-nostats'].concat(head ? ['-t', String(seg)] : ['-sseof', '-' + seg]).concat(['-i', file, '-an', '-vf', vf, '-f', 'null', '-']);
      var r = await run(FFMPEG, args, 120000), e = r.err, res = { black: 0, frozen: 0 };
      var re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g, m;
      while ((m = re.exec(e))) {
        var a = parseFloat(m[1]), b = parseFloat(m[2]);
        if (head ? a < 0.6 / fps : b > seg - 1.6 / fps) res.black = Math.max(res.black, Math.round((b - a) * fps));
      }
      var fs1 = /freeze_start:\s*([\d.]+)/.exec(e), fe = /freeze_end:\s*([\d.]+)/.exec(e);
      if (fs1) {
        var s0 = parseFloat(fs1[1]), e0 = fe ? parseFloat(fe[1]) : seg;
        if (head ? s0 < 1 / fps : !fe || e0 > seg - 1.6 / fps) res.frozen = Math.round((e0 - s0) * 100) / 100;
      }
      return res;
    };
    if (!FFMPEG) return null;
    var h = await one(true), t = await one(false);
    return { headBlack: h.black, headFrozen: h.frozen, tailBlack: t.black, tailFrozen: t.frozen };
  }

  async function loudness(file) {
    var r = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], 600000);
    var m = r.err.match(/Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/);
    if (!m) { var all = r.err.match(/I:\s*(-?[\d.]+)\s*LUFS/g); if (all && all.length) m = [0, all[all.length - 1].replace(/[^\d.\-]/g, '')]; }
    return m && m[1] !== '-inf' ? parseFloat(m[1]) : null;
  }

  // p = plan item (w, h, expectDur, fps, band {minGb,maxGb}), cfg = settings
  async function check(file, p, cfg) {
    var res = { file: file, at: Date.now(), checks: {}, pass: false, problemAt: null };
    var info = await probe(file);
    if (info.error) { res.error = info.error; res.checks.codec = { ok: false, txt: info.error }; return res; }
    res.info = info;
    var gb = info.bytes / 1e9, fps = info.fps || p.fps || 30, c = res.checks;
    // codec + frame + fps + size band
    var probs = [];
    if (info.codec !== 'h264') probs.push(info.codec + ', not H.264');
    if (p.w && (info.w !== p.w || info.h !== p.h)) probs.push(info.w + '×' + info.h + ', expected ' + p.w + '×' + p.h);
    if (p.fps && Math.abs(fps - p.fps) > 0.02) probs.push((Math.round(fps * 100) / 100) + ' fps, expected ' + (Math.round(p.fps * 100) / 100));
    if (p.band && p.band.maxGb && gb > p.band.maxGb) probs.push('over ' + p.band.maxGb + ' GB');
    var note = p.band && p.band.minGb && gb < p.band.minGb ? ' · under ' + p.band.minGb + ' GB (short clip at the bitrate cap)' : '';
    c.codec = cfg.chkCodec === false ? { ok: null, txt: 'off' } :
      { ok: !probs.length, txt: (info.codec || '?').toUpperCase() + ' · ' + info.w + '×' + info.h + ' · ' + (Math.round(fps * 100) / 100) + ' fps · ' + gb.toFixed(2) + ' GB' + (probs.length ? ' · ' + probs.join(', ') : note) };
    // duration
    if (cfg.chkDur === false || !(p.expectDur > 0)) c.dur = { ok: null, txt: cfg.chkDur === false ? 'off' : info.dur.toFixed(2) + ' s' };
    else {
      var diffF = Math.round(Math.abs(info.dur - p.expectDur) * fps);
      c.dur = { ok: diffF <= 2, txt: info.dur.toFixed(2) + ' s' + (diffF <= 2 ? ' = timeline' : ' · timeline ' + p.expectDur.toFixed(2) + ' s (' + diffF + ' frames off)') };
    }
    // frames
    if (cfg.chkFrames === false) c.frames = { ok: null, txt: 'off' };
    else {
      var ed = await edges(file, info.dur, fps);
      if (!ed) c.frames = { ok: null, txt: 'not checked (ffmpeg missing)' };
      else {
        var bad = [];
        if (ed.headBlack) { bad.push('black at start · ' + ed.headBlack + ' frame' + (ed.headBlack > 1 ? 's' : '')); res.problemAt = 0; }
        if (ed.headFrozen) { bad.push('still at start · ' + ed.headFrozen + ' s'); }
        if (ed.tailBlack) { bad.push('black at end · ' + ed.tailBlack + ' frame' + (ed.tailBlack > 1 ? 's' : '')); if (res.problemAt === null) res.problemAt = Math.max(0, info.dur - 1); }
        if (ed.tailFrozen) { bad.push('still at end · ' + ed.tailFrozen + ' s'); }
        if (res.problemAt === null && ed.headFrozen) res.problemAt = 0;
        if (res.problemAt === null && ed.tailFrozen) res.problemAt = Math.max(0, info.dur - 1);
        // black = fail; a still picture is only flagged (end cards and title holds are often still on purpose)
        var black = bad.filter(function (x) { return /^black/.test(x); }).length;
        c.frames = { ok: black ? false : bad.length ? 'warn' : true, txt: bad.length ? bad.join(' · ') + (black ? '' : ' (check: still picture)') : 'clean' };
      }
    }
    // loudness
    var target = Number(cfg.lufs) || -14;
    if (cfg.chkLoud === false) c.loud = { ok: null, txt: 'off' };
    else if (!info.audio) c.loud = { ok: cfg.loudInfo ? null : false, txt: 'no audio track' };
    else {
      var L = await loudness(file);
      if (L === null) c.loud = { ok: null, txt: 'not measured' };
      else if (cfg.loudInfo) c.loud = { ok: null, txt: L.toFixed(1) + ' LUFS (info: masters keep the source level)' };
      else c.loud = { ok: Math.abs(L - target) <= 1, txt: L.toFixed(1) + ' LUFS' + (Math.abs(L - target) <= 1 ? '' : ' (target ' + target + ' ±1)') };
      res.lufs = L;
    }
    res.pass = ['codec', 'dur', 'frames', 'loud'].every(function (k) { return !c[k] || c[k].ok !== false; });
    res.warn = ['frames'].some(function (k) { return c[k] && c[k].ok === 'warn'; });
    return res;
  }

  // ---------- Review pack ----------
  function hasVT() { return new Promise(function (r) { run(FFMPEG, ['-hide_banner', '-encoders']).then(function (x) { r(/h264_videotoolbox/.test(x.out)); }); }); }
  var vt = null;
  async function encoder() { if (vt === null) vt = await hasVT(); return vt ? ['-c:v', 'h264_videotoolbox'] : ['-c:v', 'libx264', '-preset', 'veryfast']; }

  async function frameAt(file, t, out, scale) {
    var r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1'].concat(scale ? ['-vf', scale] : []).concat([out]), 120000);
    return !r.code && fs.existsSync(out);
  }
  // dir = Review folder; returns { review, sheet, cover }
  async function reviewPack(file, info, dir, stem, cfg, coverAt) {
    fs.mkdirSync(dir, { recursive: true });
    var out = {}, dur = info.dur || 1, vert = info.h > info.w;
    var scale = vert ? 'scale=720:-2' : 'scale=-2:720';
    if (cfg.pack720 !== false) {
      var maxMB = Number(cfg.packMB) || 16, kbps = Math.max(300, Math.min(4000, Math.floor(maxMB * 8000 * 0.88 / dur) - 128));
      var f = path.join(dir, stem + '_review720.mp4');
      for (var attempt = 0; attempt < 2; attempt++) {
        var enc = await encoder();
        await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', scale].concat(enc)
          .concat(['-b:v', kbps + 'k', '-maxrate', Math.round(kbps * 1.2) + 'k', '-bufsize', Math.round(kbps * 2) + 'k', '-pix_fmt', 'yuv420p',
                   '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', f]), 1800000);
        if (fs.existsSync(f) && fs.statSync(f).size <= maxMB * 1e6) break;
        kbps = Math.max(200, Math.floor(kbps * 0.7));
      }
      if (fs.existsSync(f)) out.review = f;
    }
    if (cfg.packSheet !== false) {
      var tmp = [0.0, dur / 2, Math.max(0, dur - 0.2)].map(function (t, i) { return { t: t, f: path.join(dir, '.' + stem + '_s' + i + '.jpg') }; });
      var okAll = true;
      for (var i = 0; i < tmp.length; i++) okAll = (await frameAt(file, tmp[i].t, tmp[i].f, vert ? 'scale=-2:640' : 'scale=-2:360')) && okAll;
      var sheet = path.join(dir, stem + '_sheet.jpg');
      if (okAll) {
        await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp[0].f, '-i', tmp[1].f, '-i', tmp[2].f, '-filter_complex', 'hstack=inputs=3', '-q:v', '3', sheet], 60000);
        if (fs.existsSync(sheet)) out.sheet = sheet;
      }
      tmp.forEach(function (x) { try { fs.unlinkSync(x.f); } catch (e) {} });
    }
    if (cfg.packCover !== false) {
      var cover = path.join(dir, stem + '_cover.png');
      if (await frameAt(file, coverAt > 0 && coverAt < dur ? coverAt : 0, cover, null)) out.cover = cover;
    }
    return out;
  }

  // ---------- Social copy ----------
  async function social(file, info, dir, stem, cfg) {
    fs.mkdirSync(dir, { recursive: true });
    var f = path.join(dir, stem + '_Social.mp4'), target = Number(cfg.lufs) || -14, enc = await encoder();
    var args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', 'scale=1080:-2'].concat(enc)
      .concat(['-b:v', '8M', '-maxrate', '10M', '-bufsize', '16M', '-pix_fmt', 'yuv420p']);
    if (info.audio) args = args.concat(['-af', 'loudnorm=I=' + target + ':TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k']);
    args = args.concat(['-movflags', '+faststart', f]);
    var r = await run(FFMPEG, args, 3600000);
    return !r.code && fs.existsSync(f) ? f : null;
  }

  function notify(title, text) {
    cp.execFile('/usr/bin/osascript', ['-e', 'display notification ' + JSON.stringify(String(text)) + ' with title ' + JSON.stringify(String(title))], function () {});
  }

  var api = { FFPROBE: FFPROBE, FFMPEG: FFMPEG, probe: probe, check: check, edges: edges, loudness: loudness, reviewPack: reviewPack, social: social, frameAt: frameAt, notify: notify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UAIQC = api;
})(this);
