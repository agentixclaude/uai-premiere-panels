"""Head/tail trim finder (v2, 2026-11-24). Cuts only the start and end pause.

IN / OUT frame rule: face toward the camera, head still, mouth CLOSED, eyes OPEN, held for >= 3 frames.
Audio finds the first / last word; the face decides the frame.

End of a take (and its start, mirrored): after the last word people often stand up, look aside, reach for the
mic or talk to the crew. So the tail pause is checked with the face first; if the person moves or turns away,
the OUT stops before that moment. If the movement starts before the audio ends (crew talk picked up as speech),
the OUT is searched up to 10 s before the last sound, on the last steady, closed-mouth frame, and flagged.

Speed: a coarse face scan at 10 fps on a small frame, then only the chosen ~0.6 s is decoded at full rate.
The 10 s look-back is decoded only when the short pause window has no usable frame.

Usage: python3 trim.py clip.MP4 out_dir"""
import sys, os, json, subprocess, platform, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face

# Learned from 40 finished client outputs: editors leave ~0.8 s before the first word (p10 0.5 / p90 1.6)
# and ~0.6 s after the last word (p10 0.16 / p90 1.4).
PRE, POST = 0.80, 0.60
PRE_RANGE, POST_RANGE = (0.40, 1.60), (0.15, 1.40)
LOOKBACK = 10.0            # how far before the last word (or after the first) a frame may be searched
MOUTH_GAP, EAR_MIN, EAR_REL = 0.008, 0.18, 0.65
YAW_MAX = 0.22             # nose offset from the eye-centre / eye distance; > this = looking aside
MOVE_MAX = 0.06            # face-centre travel per 0.1 s / face height; > this = standing up, leaning, walking off
BREAK_HOLD = 0.3           # a turn / move must last this long to count (blinks and nods don't)
HOLD = 3
COARSE_FPS, COARSE_W, FINE_W = 10, 960, 1280


def probe(p):
    o = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', p]))
    s = o['streams'][0]; n, d = map(int, s['r_frame_rate'].split('/'))
    rot = 0
    for sd in s.get('side_data_list', []): rot = int(sd.get('rotation', 0) or rot)
    w, h = s['width'], s['height']
    if abs(rot) % 180 == 90: w, h = h, w
    return dict(w=w, h=h, fps=n / d, fpsn=n, fpsd=d, dur=float(o['format']['duration']), rot=rot)


def speech_bounds(p):
    """First / last word (0.5 s window rule), plus the nearest other sound outside them."""
    a = np.frombuffer(subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', '-i', p, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']), np.int16).astype(np.float32) / 32768
    hop = 320; n = len(a) // hop; r = np.sqrt((a[:n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9; db = 20 * np.log10(r)
    floor = np.percentile(db, 10); talk = np.percentile(db, 90); thr = max(floor + 12, talk - 25, -50)
    sp = db > thr; k = int(0.5 / 0.02)
    run = np.convolve(sp.astype(int), np.ones(k, int), 'valid') >= int(k * 0.7)
    idx = np.where(run)[0]
    if len(idx) == 0: return None
    first, last = int(idx[0]), int(idx[-1])
    a0, b0 = first, min(len(sp) - 1, last + k - 1)
    while a0 < b0 and not sp[a0]: a0 += 1
    while b0 > a0 and not sp[b0]: b0 -= 1
    nxt = prv = None; run_ = 0
    for x in range(b0 + 1, len(sp)):
        run_ = run_ + 1 if sp[x] else 0
        if run_ >= 3: nxt = (x - 2) * 0.02; break
    run_ = 0
    for y in range(a0 - 1, -1, -1):
        run_ = run_ + 1 if sp[y] else 0
        if run_ >= 3: prv = (y + 3) * 0.02; break
    return dict(start=first * 0.02, end=(last + k) * 0.02, next_sound=nxt, prev_sound=prv, floor_db=float(floor), thr_db=float(thr))


def _hw():
    return ['-hwaccel', 'videotoolbox'] if platform.system() == 'Darwin' else []


def frames(p, t0, t1, info, W, fps=None):
    """Decode [t0, t1] scaled to width W; every frame, or `fps` frames per second. Returns (frames, times)."""
    t0 = max(0.0, t0); t1 = min(info['dur'], t1)
    if t1 <= t0: return np.zeros((0, 2, 2, 3), np.uint8), []
    if info['h'] > info['w']: W = min(W, 720)   # vertical 8K: small decode, else out of memory
    H = int(round(W * info['h'] / info['w'] / 2)) * 2
    vf = (f'fps={fps},' if fps else '') + f'scale={W}:{H}:flags=fast_bilinear'
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-threads', '4'] + _hw() + ['-ss', f'{t0:.3f}', '-i', p, '-t', f'{t1 - t0:.3f}',
           '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    try: raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        if not _hw(): raise
        raw = subprocess.check_output([c for c in cmd if c not in ('-hwaccel', 'videotoolbox')])
    f = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
    step = 1.0 / (fps or info['fps'])
    return f, [t0 + i * step for i in range(len(f))]


def keytimes(p, t0, t1):
    """Keyframe times in [t0, t1] from the packet index (no decoding)."""
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags',
                                   '-read_intervals', f'{max(0, t0):.3f}%{t1:.3f}', '-of', 'csv=p=0', p]).decode()
    ts = []
    for line in out.splitlines():
        parts = line.split(',')
        if len(parts) >= 2 and 'K' in parts[1]:
            try:
                t = float(parts[0])
                if t0 - 0.01 <= t <= t1 + 0.01: ts.append(t)
            except ValueError: pass
    return sorted(set(ts))


def scan(p, info, t0, t1, W=COARSE_W):
    """Coarse look: keyframes only (about one per second on these cameras), so a 12 s window costs little."""
    t0 = max(0.0, t0); t1 = min(info['dur'], t1)
    face.reset()
    if info['h'] > info['w']: W = min(W, 720)
    H = int(round(W * info['h'] / info['w'] / 2)) * 2
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-threads', '4'] + _hw() + ['-discard', 'nokey', '-ss', f'{t0:.3f}', '-i', p,
           '-t', f'{t1 - t0:.3f}', '-vf', f'scale={W}:{H}:flags=fast_bilinear', '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    try: raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        raw = subprocess.check_output([c for c in cmd if c not in ('-hwaccel', 'videotoolbox')], stderr=subprocess.DEVNULL)
    fr = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
    kt = keytimes(p, t0, t1)
    if len(kt) != len(fr):    # fall back to even spacing if the index and the decoder disagree
        kt = list(np.linspace(t0, t1, len(fr), endpoint=False)) if len(fr) else []
    return [face.state(x) for x in fr], kt, fr


def fine(p, info, t0, t1):
    face.reset()
    fr, ts = frames(p, t0, t1, info, FINE_W)
    return [face.state(x) for x in fr], ts, fr


def calibrate(states):
    g = np.array([s['gap'] for s in states if s]); e = [s['ear'] for s in states if s]
    if len(g) < 5: return None
    base = float(np.percentile(g, 5)); opn = float(np.percentile(g, 90))
    thr = base + 0.35 * (opn - base) if opn - base > 0.01 else base + 0.008
    return dict(closed_thr=round(float(min(max(thr, MOUTH_GAP), 0.03)), 4), rest=round(base, 4), open=round(opn, 4), eye_ref=round(float(np.median(e)), 3))


def presenter(states, ts):
    """Per sample: face found, toward the camera, head still."""
    ok = []
    for i, s in enumerate(states):
        good = s is not None and abs(s.get('yaw', 0)) <= YAW_MAX
        if good and i > 0 and states[i - 1] is not None:
            dt = max(1e-3, ts[i] - ts[i - 1]) / 0.1
            good = face.moved(s, states[i - 1]) / dt <= MOVE_MAX
        ok.append(bool(good))
    return ok


def breaks(ok, ts):
    """Times where presenter() is false for >= BREAK_HOLD (a real turn / stand-up, not a blink)."""
    out, i = [], 0
    while i < len(ok):
        if not ok[i]:
            j = i
            while j < len(ok) and not ok[j]: j += 1
            if ts[min(j, len(ts) - 1)] - ts[i] >= BREAK_HOLD or j == len(ok): out.append((ts[i], ts[min(j, len(ts) - 1)]))
            i = j
        else: i += 1
    return out


def good_frame(s, cal):
    return (s is not None and s['gap'] < cal['closed_thr'] and s['ear'] > EAR_MIN and s['ear'] > EAR_REL * cal['eye_ref']
            and abs(s.get('yaw', 0)) <= YAW_MAX)


def refine(p, info, t, side, cal, lo, hi):
    """Full-rate decode of ~0.6 s around t: first (IN) / last (OUT) frame of a >= HOLD closed, open-eyed, frontal run."""
    face.reset()
    fr, ts = frames(p, max(lo, t - 0.3), min(hi, t + 0.3), info, FINE_W)
    st = [face.state(x) for x in fr]
    ok = [good_frame(s, cal) for s in st]
    cand = []
    for i in range(len(fr)):
        if side == 'in' and i + HOLD <= len(fr) and all(ok[i:i + HOLD]): cand.append(i)
        if side == 'out' and i - HOLD + 1 >= 0 and all(ok[i - HOLD + 1:i + 1]): cand.append(i)
    if not cand: return None
    i = min(cand, key=lambda k: abs(ts[k] - t))
    return ts[i], st[i], fr[i]


def _runs(ok, side):
    """Indexes where a >= HOLD run of good frames starts (IN) or ends (OUT)."""
    c = []
    for i in range(len(ok)):
        if side == 'in' and i + HOLD <= len(ok) and all(ok[i:i + HOLD]): c.append(i)
        if side == 'out' and i - HOLD + 1 >= 0 and all(ok[i - HOLD + 1:i + 1]): c.append(i)
    return c


def choose(p, info, sb, side):
    """One keyframe pass over the pause and the 10 s next to it, then a full-rate decode of the pause only."""
    dur, S, E = info['dur'], sb['start'], sb['end']
    if side == 'out':
        target, edge = E + POST, E
        hard = min(dur - 1.0 / info['fps'], E + POST_RANGE[1])
        if sb.get('next_sound') is not None: hard = min(hard, max(E + 0.1, sb['next_sound'] - 0.1))
        kwin = (max(0.0, E - LOOKBACK), min(dur, hard + 1.0))
        zone = (E + POST_RANGE[0], hard)
    else:
        target, edge = S - PRE, S
        hard = max(0.0, S - PRE_RANGE[1])
        if sb.get('prev_sound') is not None: hard = max(hard, min(S - 0.1, sb['prev_sound'] + 0.1))
        kwin = (max(0.0, hard - 1.0), min(dur, S + LOOKBACK))
        zone = (hard, S - PRE_RANGE[0])
    kst, kts, kfr = scan(p, info, *kwin)
    cal = calibrate(kst)
    # the pause itself, every frame
    fst, fts, ffr = fine(p, info, zone[0] - 0.4, zone[1] + 0.4)
    cal = cal or calibrate(fst)
    if cal is None: return None, None, [f'{side}: no face found - set manually']
    merged = sorted(zip(kts + fts, kst + fst, list(kfr) + list(ffr)), key=lambda x: x[0])
    ts = [m[0] for m in merged]; st = [m[1] for m in merged]; fr = [m[2] for m in merged]
    ok = presenter(st, ts)
    # movement / turning in the pause (talking gestures inside the words don't count)
    limit = zone[1] if side == 'out' else zone[0]
    for b0, b1 in breaks(ok, ts):
        if side == 'out' and b0 >= E - 0.3: limit = min(limit, b0 - 0.1); break
    if side == 'in':
        for b0, b1 in reversed(breaks(ok, ts)):
            if b1 <= S + 0.3: limit = max(limit, b1 + 0.1); break
    flags = []
    # 1) the pause, full rate
    good = [ok[i] and good_frame(st[i], cal) for i in range(len(st))]
    fi = [i for i, t in enumerate(ts) if (zone[0] <= t <= limit if side == 'out' else limit <= t <= zone[1])]
    sub = [good[i] for i in fi]
    cand = [fi[j] for j in _runs(sub, side)] if fi else []
    if cand:
        i = min(cand, key=lambda k: abs(ts[k] - target))
        if (side == 'out' and limit < zone[1] - 0.05) or (side == 'in' and limit > zone[0] + 0.05):
            flags.append(f'{side}: person moves or looks away in the pause - {side.upper()} set before it')
        return (ts[i], st[i], fr[i]), cal, flags
    # 1b) person steady (toward camera, not moving) but no frame passes the strict mouth / eye test: best frame of the PAUSE, not a jump into the talk
    pz = [i for i in fi if ok[i] and st[i] is not None and st[i]['ear'] > EAR_MIN * 0.8]
    if pz:
        i = min(pz, key=lambda k: st[k]['gap'] / max(cal['closed_thr'], 1e-6) + 0.5 * abs(ts[k] - target))
        flags.append(f'{side}: no frame in the pause passes mouth-closed / eyes-open; best frame of the pause used, REVIEW')
        return (ts[i], st[i], fr[i]), cal, flags
    # 2) look-back: steady, closed-mouth keyframe up to 10 s inside the talk, refined at full rate
    if side == 'out': pool = [i for i, t in enumerate(ts) if kwin[0] <= t <= min(limit, zone[1]) and good[i]]
    else: pool = [i for i, t in enumerate(ts) if max(limit, zone[0]) <= t <= kwin[1] and good[i]]
    if not pool: return None, cal, [f'{side}: no steady, closed-mouth face frame within 10 s - set manually']
    k = max(pool, key=lambda i: ts[i]) if side == 'out' else min(pool, key=lambda i: ts[i])
    rst, rts, rfr = fine(p, info, ts[k] - 0.35, ts[k] + 0.35)
    rok = presenter(rst, rts); rg = [rok[i] and good_frame(rst[i], cal) for i in range(len(rst))]
    rc = _runs(rg, side)
    pick = (rts[min(rc, key=lambda j: abs(rts[j] - ts[k]))], rst[min(rc, key=lambda j: abs(rts[j] - ts[k]))], rfr[min(rc, key=lambda j: abs(rts[j] - ts[k]))]) if rc else (ts[k], st[k], fr[k])
    flags.append(f'{side}: no steady closed-mouth frame in the pause (person moves / looks away / keeps talking) - {side.upper()} set {abs(pick[0] - edge):.1f} s {"before the last" if side == "out" else "after the first"} sound, REVIEW')
    return pick, cal, flags


def run(p, out):
    os.makedirs(out, exist_ok=True); name = os.path.splitext(os.path.basename(p))[0]
    import time; T = {}; t_ = time.time()
    info = probe(p); sb = speech_bounds(p); T['audio'] = round(time.time() - t_, 1)
    res = dict(clip=name, **info, speech=sb, engine='trim v2.1 (transcript + audio + face, 10 s look-back, best-pause-frame, vertical low-res, 4 threads)')
    if sb is None: res['flag'] = 'no speech found'; return res
    # the transcript says which sounds belong to the take (crew talk, count-ins, "was that good?" don't)
    t_ = time.time()
    try:
        import transcript
        tb = transcript.script_bounds(p, info['dur'])
    except Exception as e:
        tb = None; res['transcript_error'] = str(e)[:200]
    T['transcript'] = round(time.time() - t_, 1)
    if tb:
        res['transcript'] = tb
        if tb['dropped_head'] and tb['start'] > sb['start'] + 0.1:    # talk before the first line: start later, treat it as a sound to avoid
            if tb['head_prev'] is not None: sb['prev_sound'] = max(sb.get('prev_sound') or 0, tb['head_prev'])
            sb['start'] = tb['start']
        if tb['dropped_tail'] and tb['end'] < sb['end'] - 0.5:        # talk after the last line: end earlier, the chatter becomes the next sound
            if tb['tail_next'] is not None: sb['next_sound'] = min(sb.get('next_sound') or 1e9, tb['tail_next'])
            sb['end'] = tb['end']
        if tb['dropped_head'] or tb['dropped_tail']:
            res.setdefault('flags', []).append('transcript: ignored ' + ' / '.join(
                ([f'before: "{" | ".join(tb["dropped_head"])}"'] if tb['dropped_head'] else []) +
                ([f'after: "{" | ".join(tb["dropped_tail"])}"'] if tb['dropped_tail'] else [])))
    for side in ('in', 'out'):
        t_ = time.time()
        pick, cal, flags = choose(p, info, sb, side)
        T[side] = round(time.time() - t_, 1)
        res[side + '_calibration'] = cal
        if flags: res.setdefault('flags', []).extend(flags)
        if pick is None: res[side] = None; continue
        t, st, img = pick
        res[side] = dict(t=t, frame=int(round(t * info['fpsn'] / info['fpsd'])), **st)
        import PIL.Image as I; I.fromarray(img).save(os.path.join(out, f'{name}_{side}.jpg'), quality=88)
    res['timing'] = T
    json.dump(res, open(os.path.join(out, f'{name}.json'), 'w'), indent=1, default=str)
    return res


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1], sys.argv[2]), indent=1, default=str))
