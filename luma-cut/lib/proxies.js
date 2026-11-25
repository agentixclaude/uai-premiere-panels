/* UAI Luma Cut — proxies.
   Heavy footage (4K and up: 4K, 6K, 8K HEVC / H.264 / ProRes) gets a 1080p ProRes Proxy copy that Premiere plays
   while editing. Exports always use the original files.
   Encoding stays on Apple's media engines (VideoToolbox decode, scale and ProRes encode); when that path fails
   (older ffmpeg, Intel Mac) it falls back to the software ProRes encoder. */
var fs = require('fs'), path = require('path'), cp = require('child_process');

var MIN_LONG_EDGE = 2561;          // proxies for anything larger than 2.5K (UHD 3840 and up)
var PROXY_LONG_EDGE = 1920;

function ffprobeFor(ffmpeg) {
  var p = path.join(path.dirname(ffmpeg), 'ffprobe');
  return fs.existsSync(p) ? p : null;
}

// {w, h, dur} of the first video stream, or null
function probe(ffprobe, file, cb) {
  cp.execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
    { timeout: 30000 }, function (err, stdout) {
      if (err) return cb(null);
      try {
        var j = JSON.parse(stdout), s = (j.streams || [])[0];
        if (!s || !s.width) return cb(null);
        cb({ w: s.width, h: s.height, dur: parseFloat((j.format || {}).duration) || 0 });
      } catch (e) { cb(null); }
    });
}

function isHeavy(info) { return !!info && Math.max(info.w, info.h) >= MIN_LONG_EDGE; }

// Proxy size: long edge 1920, same shape, even numbers
function proxySize(info) {
  var even = function (v) { return Math.max(2, Math.round(v / 2) * 2); };
  return info.w >= info.h ? { w: PROXY_LONG_EDGE, h: even(PROXY_LONG_EDGE * info.h / info.w) }
                          : { w: even(PROXY_LONG_EDGE * info.w / info.h), h: PROXY_LONG_EDGE };
}

// <client>/Proxies mirrors the folders under the client's footage folder, so cards that restart at C0001 never collide:
//   <client>/Raw Data/C0004.MP4      -> <client>/Proxies/C0004_Proxy.mov
//   <client>/Raw Data/Day 2/C0001.MP4 -> <client>/Proxies/Day 2/C0001_Proxy.mov
// Media outside the client folder gets a Proxies folder next to it.
function proxyPath(media, clientDir) {
  var base = path.basename(media).replace(/\.[^.]+$/, '') + '_Proxy.mov';
  if (clientDir) {
    var rel = path.relative(clientDir, path.dirname(media));
    if (rel === '') return path.join(clientDir, 'Proxies', base);
    if (rel.indexOf('..') !== 0 && !path.isAbsolute(rel)) {
      var parts = rel.split(path.sep).slice(1);              // drop the footage folder itself (Raw Data)
      return path.join.apply(path, [clientDir, 'Proxies'].concat(parts, [base]));
    }
  }
  return path.join(path.dirname(media), 'Proxies', base);
}

function hasFile(p) { try { return fs.statSync(p).size > 0; } catch (e) { return false; } }

function args(src, part, size, hardware) {
  var common = ['-map', '0:v:0', '-map', '0:a?', '-c:a', 'pcm_s16le', '-map_metadata', '0', '-progress', 'pipe:1', '-nostats', part];
  if (hardware) {
    return ['-hide_banner', '-v', 'error', '-y', '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-i', src,
      '-vf', 'scale_vt=w=' + size.w + ':h=' + size.h, '-c:v', 'prores_videotoolbox', '-profile:v', 'proxy'].concat(common);
  }
  return ['-hide_banner', '-v', 'error', '-y', '-i', src,
    '-vf', 'scale=' + size.w + ':' + size.h, '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le'].concat(common);
}

// Encodes one proxy. onProgress(0..1). cb(err). Returns { cancel() }.
function encode(ffmpeg, src, out, info, onProgress, cb) {
  var size = proxySize(info), part = out.replace(/\.mov$/i, '') + '.part.mov', child = null, cancelled = false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  function run(hardware) {
    var errText = '';
    child = cp.spawn(ffmpeg, args(src, part, size, hardware));
    child.stdout.on('data', function (d) {
      var m = String(d).match(/out_time_us=(\d+)/g);
      if (m && info.dur) onProgress(Math.min(1, parseInt(m[m.length - 1].split('=')[1], 10) / 1e6 / info.dur));
    });
    child.stderr.on('data', function (d) { errText += d; });
    child.on('error', function (e) { errText += e.message; });
    child.on('close', function (code) {
      child = null;
      if (cancelled) { try { fs.unlinkSync(part); } catch (e) {} return cb(new Error('stopped')); }
      if (code === 0 && hasFile(part)) {
        try { fs.renameSync(part, out); } catch (e) { return cb(e); }
        return cb(null);
      }
      try { fs.unlinkSync(part); } catch (e) {}
      if (hardware) return run(false);                      // Apple media engine path failed: software encoder
      cb(new Error((errText.trim().split('\n').pop() || 'ffmpeg exited with ' + code).slice(0, 200)));
    });
  }
  run(true);
  return { cancel: function () { cancelled = true; if (child) child.kill('SIGTERM'); } };
}

module.exports = { ffprobeFor: ffprobeFor, probe: probe, isHeavy: isHeavy, proxySize: proxySize, proxyPath: proxyPath, hasFile: hasFile, encode: encode, MIN_LONG_EDGE: MIN_LONG_EDGE };
