"""Head/tail trim finder (engine v3, 2026-11-26). Cuts only the start and end pause.

1. Audio + transcript: where the real talk starts and ends (transcript.py drops count-ins, take instructions,
   apologies and closing remarks). IN anchor = first word of the delivery (Hi / Hey / I'm / I ...), OUT anchor = last
   word of the delivery. The IN never goes into the speech, and never before the count-in / instruction has ended.
2. Picture: every frame of the pause is checked, and a frame counts only when ALL pass, held >= 3 frames:
   face toward the camera, head still, mouth closed, no teeth showing, eyes open, hands in a rest position (still).
   IN is searched 0.25-3 s before the first word (up to 5 s when nothing passes), OUT 0.15-3 s after the last word
   (up to 5 s), stopping before the person stands up / looks aside / the next sound.
3. Nothing passes: the best frame of the pause (fewest failed checks, nearest the usual gap), flagged REVIEW with the
   failed checks named.
The panel adds the clean edge (body cut 2 frames wider, markers / export 2 frames inside), so these frames are the
first and last frames that get exported.

Usage: python3 trim.py clip.MP4 out_dir"""
import sys, os, json, subprocess, platform, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face

ENGINE = 'trim v3.1 (OUT anchored on the speaker end audio, +-4 s pause search; transcript openers + count-in/closing-remark drop; face + mouth + teeth + eyes + hands + still, all held 3 frames; no IN into the speech)'
PRE_T, POST_T = 0.80, 0.60          # usual gap before the first / after the last word (40 finished outputs)
IN_WIN, OUT_WIN = (0.25, 3.0), (0.15, 3.0)
EXT = 5.0                            # wider search when nothing passes in the normal window
SAFE = 0.15                          # keep this far from a dropped count-in / closing remark
MOUTH_GAP, EAR_MIN, EAR_REL = 0.008, 0.18, 0.65
TEETH_MAX = 0.08                     # share of the inner-lip outline that looks like teeth
YAW_MAX = 0.22
MOVE_MAX = 0.06                      # face-centre travel per 0.1 s / face height
HAND_MOVE = 0.25                     # wrist travel per 0.1 s / torso height
BREAK_HOLD = 0.3
HOLD = 3
FINE_W = 1920                         # proxies are 1920 wide; the face is cropped from the full frame


def probe(p):
    o = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', p]))
    s = o['streams'][0]; n, d = map(int, s['r_frame_rate'].split('/'))
    rot = 0
    for sd in s.get('side_data_list', []): rot = int(sd.get('rotation', 0) or rot)
    rot = int(s.get('tags', {}).get('rotate', 0) or 0) or rot
    w, h = s['width'], s['height']
    if abs(rot) % 180 == 90: w, h = h, w
    return dict(w=w, h=h, fps=n / d, fpsn=n, fpsd=d, dur=float(o['format']['duration']), rot=rot)


class Audio:
    """Loudness every 20 ms; onset / offset search around a word time."""
    def __init__(self, p):
        a = np.frombuffer(subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', '-i', p, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']),
                          np.int16).astype(np.float32) / 32768
        hop = 320; n = len(a) // hop
        r = np.sqrt((a[:n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9; self.db = 20 * np.log10(r)
        floor = np.percentile(self.db, 10); talk = np.percentile(self.db, 90)
        self.thr = max(floor + 12, talk - 25, -50); self.sp = self.db > self.thr

    def t(self, i): return i * 0.02

    def i(self, t): return int(max(0, min(len(self.sp) - 1, round(t / 0.02))))

    def bounds(self):
        k = 25; run = np.convolve(self.sp.astype(int), np.ones(k, int), 'valid') >= int(k * 0.7)
        idx = np.where(run)[0]
        if len(idx) == 0: return None
        return dict(start=self.t(idx[0]), end=self.t(idx[-1] + k))

    def onset(self, t, back=0.4, fwd=0.15):
        """Start of the sound the word at t belongs to (whisper times drift by ~0.1-0.2 s)."""
        i, lo, hi = self.i(t), self.i(t - back), self.i(t + fwd)
        if not self.sp[i]:
            while i < hi and not self.sp[i]: i += 1
            if not self.sp[i]: return t
        while i > lo and self.sp[i - 1]: i -= 1
        return self.t(i)

    def offset(self, t, fwd=0.5, back=0.1):
        i = self.i(t - back); hi = self.i(t + fwd)
        while i < hi and self.sp[i]: i += 1
        return self.t(i)

    def next_sound(self, t, need=3):
        """Start of the next sound lasting >= need x 20 ms (need=10: speech, not a breath, click or rustle)."""
        run = 0
        for x in range(self.i(t), len(self.sp)):
            run = run + 1 if self.sp[x] else 0
            if run >= need: return self.t(x - need + 1)
        return None

    def prev_sound(self, t):
        run = 0
        for y in range(self.i(t), -1, -1):
            run = run + 1 if self.sp[y] else 0
            if run >= 3: return self.t(y + 3)
        return None


def _hw():
    return ['-hwaccel', 'videotoolbox'] if platform.system() == 'Darwin' else []


def _dims(info, W):
    W = min(W, info['w'])
    if info['h'] > info['w']: W = min(W, 1080)  # vertical: picture as seen (after transpose)
    return W, int(round(W * info['h'] / info['w'] / 2)) * 2


def stream(p, info, t0, t1, fn, W=FINE_W, fps=None):
    """Decode [t0, t1] frame by frame (no big buffer); fn(frame_index, time, rgb)."""
    step = info['fpsd'] / info['fpsn']
    f0 = max(0, int(round(t0 / step))); f1 = min(int(info['dur'] / step) - 1, int(round(t1 / step)))
    if f1 < f0: return
    W, H = _dims(info, W)
    vf = (f'fps={fps},' if fps else '') + (info['tr'] + ',' if info.get('tr') else '') + f'scale={W}:{H}:flags=fast_bilinear'
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-threads', '4'] + _hw() + ['-ss', f'{f0 * step:.4f}', '-i', p,
           '-frames:v', str((f1 - f0 + 1) if not fps else int((f1 - f0 + 1) * step * fps) + 1),
           '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    pr = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    sz = W * H * 3; k = 0
    while True:
        b = pr.stdout.read(sz)
        if len(b) < sz: break
        fi = f0 + k if not fps else f0 + int(round(k / fps / step))
        fn(fi, fi * step, np.frombuffer(b, np.uint8).reshape(H, W, 3)); k += 1
    pr.stdout.close(); pr.wait()


def one_frame(p, info, fi, W=1280):
    out = []
    stream(p, info, fi * info['fpsd'] / info['fpsn'], fi * info['fpsd'] / info['fpsn'], lambda i, t, x: out.append(x.copy()), W=W)
    return out[0] if out else None


def calibrate(p, info, t0, t1):
    """Mouth rest / open levels and normal eye opening from the talk next to the pause (5 frames a second)."""
    face.reset(); st = []
    stream(p, info, t0, t1, lambda i, t, x: st.append(face.state(x)), fps=5)
    g = np.array([s['gap'] for s in st if s]); e = [s['ear'] for s in st if s]
    if len(g) < 5: return None
    base = float(np.percentile(g, 5)); opn = float(np.percentile(g, 90))
    thr = base + 0.30 * (opn - base) if opn - base > 0.01 else base + 0.008
    return dict(closed_thr=round(float(min(max(thr, MOUTH_GAP), 0.025)), 4), rest=round(base, 4), open=round(opn, 4), eye_ref=round(float(np.median(e)), 3))


def face_fails(s, cal):
    if s is None: return ['no face']
    f = []
    if abs(s.get('yaw', 0)) > YAW_MAX: f.append('looking aside')
    if s['gap'] >= cal['closed_thr']: f.append('mouth open')
    if s.get('teeth', 0) > TEETH_MAX: f.append('teeth showing')
    if s['ear'] <= EAR_MIN or s['ear'] <= EAR_REL * cal['eye_ref']: f.append('eyes closed')
    return f


def window(p, info, t0, t1, cal):
    """Every frame in [t0, t1]: face state, and hands for frames whose face already passes."""
    face.reset(); rows = []

    def fn(fi, t, x):
        s = face.state(x); r = dict(f=fi, t=t, s=s, fails=face_fails(s, cal))
        if not r['fails']: r['h'] = face.hands(x, s)
        rows.append(r)
    stream(p, info, t0, t1, fn)
    # head still / hands still / hands at rest, from neighbours
    for k, r in enumerate(rows):
        if r['s'] is None: continue
        q = rows[k - 1] if k else None
        if q and q['s'] is not None:
            dt = max(1e-3, r['t'] - q['t']) / 0.1
            if face.moved(r['s'], q['s']) / dt > MOVE_MAX: r['fails'].append('head moving')
        h = r.get('h')
        if h:
            if h.get('hands') == 'raised': r['fails'].append('hands raised')
            if q and q.get('h'):
                for w in ('lw', 'rw'):
                    if w in h and w in q['h']:
                        d = np.hypot(h[w][0] - q['h'][w][0], h[w][1] - q['h'][w][1]) / max(h.get('torso', 1), 1)
                        if d / (max(1e-3, r['t'] - q['t']) / 0.1) > HAND_MOVE: r['fails'].append('hands moving'); break
    return rows


def _runs(rows, side):
    ok = [not r['fails'] for r in rows]; c = []
    for i in range(len(rows)):
        if side == 'in' and i + HOLD <= len(rows) and all(ok[i:i + HOLD]): c.append(i)
        if side == 'out' and i - HOLD + 1 >= 0 and all(ok[i - HOLD + 1:i + 1]): c.append(i)
    return c


def walk_off(rows, E):
    """First time after E where the person turns away / moves for >= BREAK_HOLD (stands up, reaches, talks to crew)."""
    i = 0
    while i < len(rows):
        bad = rows[i]['s'] is None or 'looking aside' in rows[i]['fails'] or 'head moving' in rows[i]['fails']
        if bad and rows[i]['t'] >= E:
            j = i
            while j < len(rows) and (rows[j]['s'] is None or 'looking aside' in rows[j]['fails'] or 'head moving' in rows[j]['fails']): j += 1
            if rows[min(j, len(rows) - 1)]['t'] - rows[i]['t'] >= BREAK_HOLD or j == len(rows): return rows[i]['t']
            i = j
        else: i += 1
    return None


def pick(p, info, side, S, E, lo_bound, hi_bound, cal):
    """Returns (row, flags). lo/hi_bound: the hard limits from dropped speech and the file edges."""
    flags = []
    if side == 'in':
        target = S - PRE_T
        a, b = max(lo_bound, S - IN_WIN[1]), S - IN_WIN[0]
        if b <= a:
            b = max(a, S - 0.04)
            flags.append(f'in: only {max(0, S - lo_bound):.2f} s between the dropped words / file start and the first word')
    else:
        target = E + POST_T
        a, b = E + OUT_WIN[0], min(hi_bound, E + OUT_WIN[1])
        if b <= a:
            a = min(a, max(E + 0.04, hi_bound - 0.04)); b = max(a, hi_bound)
            flags.append(f'out: only {max(0, hi_bound - E):.2f} s between the last word and the next sound / file end')
    rows = window(p, info, a, b, cal)
    if side == 'out' and rows:
        w = walk_off(rows, E + OUT_WIN[0])
        if w is not None and w < b:
            rows = [r for r in rows if r['t'] < w - 0.1] or rows[:1]
            flags.append(f'out: person moves / looks away {w - E:.1f} s after the last word - OUT kept before it')
    cand = _runs(rows, side)
    if not cand:                                  # wider search
        if side == 'in' and S - EXT < a - 0.05 and max(lo_bound, S - EXT) < a:
            more = window(p, info, max(lo_bound, S - EXT), a - 1e-3, cal); rows = more + rows
        if side == 'out' and b < min(hi_bound, E + EXT) - 0.05 and not any('moves / looks away' in x for x in flags):
            more = window(p, info, b + 1e-3, min(hi_bound, E + EXT), cal)
            w = walk_off(more, b)
            if w is not None: more = [r for r in more if r['t'] < w - 0.1]
            rows = rows + more
        cand = _runs(rows, side)
    if cand:
        i = min(cand, key=lambda k: abs(rows[k]['t'] - target))
        r = rows[i]
        g = (S - r['t']) if side == 'in' else (r['t'] - E)
        if g > (IN_WIN[1] if side == 'in' else OUT_WIN[1]) + 0.01:
            flags.append(f'{side}: clean frame found {g:.1f} s from the {"first" if side == "in" else "last"} word (wider search)')
        return r, flags
    if not rows: return None, flags + [f'{side}: no frames in the pause - set manually']
    # best frame of the pause: fewest failed checks, then nearest the usual gap
    wt = {'no face': 5, 'looking aside': 3, 'mouth open': 3, 'teeth showing': 2, 'eyes closed': 2, 'hands raised': 2, 'hands moving': 1, 'head moving': 1}
    i = min(range(len(rows)), key=lambda k: sum(wt.get(x, 1) for x in rows[k]['fails']) + 0.3 * abs(rows[k]['t'] - target))
    r = rows[i]
    from collections import Counter
    why = ', '.join(f'{k} {v * 100 // len(rows)}%' for k, v in Counter(x for q in rows for x in q['fails']).most_common(3))
    flags.append(f'{side}: no frame in the pause passes every check ({why}); best frame used ({", ".join(r["fails"]) or "single frame"}), REVIEW')
    return r, flags


def _clean(r, fl):
    return r is not None and not r['fails'] and not any('REVIEW' in x for x in fl)


def lookback_pause(p, info, au, E, cal, back=4.0):
    """Pauses of >= 0.3 s silence in [E - back, E]; the latest clean, held frame inside one of them."""
    i0, i1 = au.i(E - back), au.i(E)
    pauses, k = [], i0
    while k < i1:
        if not au.sp[k]:
            j = k
            while j < i1 and not au.sp[j]: j += 1
            if (j - k) * 0.02 >= 0.3: pauses.append((au.t(k) + 0.05, au.t(j) - 0.05))
            k = j
        else: k += 1
    for a, b in reversed(pauses):
        rows = window(p, info, a, b, cal); c = _runs(rows, 'out')
        if c: return rows[c[-1]]
    return None


def run(p, out, rot=None):
    import time
    os.makedirs(out, exist_ok=True); name = os.path.splitext(os.path.basename(p))[0].replace('_Proxy', '')
    T = {}; t_ = time.time()
    info = probe(p)
    if rot is not None and abs(int(rot)) % 180 == 90 and info['w'] > info['h'] and not info['rot']:
        # proxy stored unrotated: turn it so the face is upright (rot -90 -> transpose=2)
        info['tr'] = 'transpose=2' if int(rot) == -90 else 'transpose=1'; info['w'], info['h'] = info['h'], info['w']
    au = Audio(p); ab = au.bounds(); T['audio'] = round(time.time() - t_, 1)
    res = dict(clip=name, **info, engine=ENGINE)
    if ab is None: res['flag'] = 'no speech found'; return res
    flags = []
    t_ = time.time()
    try:
        import transcript
        tb = transcript.bounds(p, info['dur'])
    except Exception as e:
        tb = None; res['transcript_error'] = str(e)[:200]
    T['transcript'] = round(time.time() - t_, 1)
    step = 1 / info['fps']
    if tb:
        res['transcript'] = tb
        S = au.onset(tb['start']); E = au.offset(tb['end'])
        lo = min(au.offset(tb['head_prev'], fwd=0.2) + SAFE, S - 0.1) if tb['head_prev'] is not None else 0.0
        nxt = max(au.onset(tb['tail_next']), E + 0.1) if tb['tail_next'] is not None else au.next_sound(E + 0.15)
        if tb['dropped_head']: flags.append(f'transcript: ignored before "{tb["first_words"][:40]}": "{tb["dropped_head"][-90:]}"')
        if tb['dropped_tail']: flags.append(f'transcript: ignored after "{tb["last_words"][-40:]}": "{tb["dropped_tail"][:90]}"')
    else:
        S, E = ab['start'], ab['end']; lo = 0.0; nxt = au.next_sound(E + 0.15)
        flags.append('no transcript - audio only, REVIEW')
    if not tb or not tb['dropped_head']:
        ps = au.prev_sound(S - 0.25)
        if ps is not None and S - ps < IN_WIN[1]: lo = max(lo, ps + 0.1)
    hi = min(info['dur'] - step, (nxt - SAFE) if nxt is not None else info['dur'])
    res['speech'] = dict(start=S, end=E, in_limit=lo, out_limit=hi)
    t_ = time.time()
    cal = calibrate(p, info, S + 0.3, min(info['dur'], S + 8.0))
    if cal is None: cal = calibrate(p, info, max(0, E - 8.0), E - 0.3)
    T['calibrate'] = round(time.time() - t_, 1)
    res['calibration'] = cal
    if cal is None:
        res['flags'] = flags + ['no face found - set IN/OUT manually']; return res
    for side in ('in', 'out'):
        t_ = time.time()
        if side == 'in':
            r, fl = pick(p, info, side, S, E, lo, hi, cal)
            if not _clean(r, fl) and tb and tb.get('soft_start') is not None:
                # "Okay, my name is ..." said in one breath: no clean frame between, so start before the filler (user, AC#12 C0031)
                S2 = au.onset(tb['soft_start']); lo2 = au.offset(tb['soft_prev'], fwd=0.2) + SAFE if tb.get('soft_prev') else 0.0
                r2, fl2 = pick(p, info, side, S2, E, min(lo2, S2 - 0.1), hi, cal)
                if _clean(r2, fl2): r, fl = r2, fl2 + [f'in: no clean frame between the filler and the first line, so IN is before the filler, check']
        else:
            # OUT anchors on where the speaker's audio really ends (his closing words stay in; only short crew words after
            # them, like "Perfect.", are left out). User rule 26 Nov: match the end audio, then find the pause and a closed
            # mouth around +-3-4 s.
            Ea = au.offset(tb['speaker_end']) if tb else E
            n1 = (au.onset(tb['speaker_next']) if tb and tb.get('speaker_next') is not None else au.next_sound(Ea + 0.15, 10))
            hi1 = min(info['dur'] - step, (n1 - SAFE) if n1 is not None else info['dur'])
            res['speech']['end'] = Ea
            r, fl = pick(p, info, side, S, Ea, lo, hi1, cal)
            if not _clean(r, fl) and n1 is not None and hi1 < Ea + OUT_WIN[1]:
                # the next sound is the crew: try the pause after everything
                Ez = au.offset(tb['full_end']) if tb else Ea; nz = au.next_sound(Ez + 0.15, 10)
                hz = min(info['dur'] - step, (nz - SAFE) if nz is not None else info['dur'])
                r2, fl2 = pick(p, info, side, S, Ez, lo, hz, cal)
                if _clean(r2, fl2): r, fl = r2, fl2 + ['out: crew words right after the last line, OUT after them, check']
            if not _clean(r, fl):
                # go back: the last pause (>= 0.3 s of silence) inside the final 4 s of speech with a clean frame
                r3 = lookback_pause(p, info, au, Ea, cal)
                if r3 is not None: r, fl = r3, ['out: no clean frame after the last word; OUT in the last pause %.1f s before it, REVIEW' % (Ea - r3['t'])]
        clean = _clean(r, fl)
        T[side] = round(time.time() - t_, 1); flags += fl
        if r is None: res[side] = None; continue
        st = r['s'] or {}
        res[side] = dict(t=r['t'], frame=r['f'], gap_s=round((S - r['t']) if side == 'in' else (r['t'] - res['speech']['end']), 2), fails=r['fails'],
                         gap=st.get('gap'), teeth=st.get('teeth'), ear=st.get('ear'), yaw=st.get('yaw'), hands=(r.get('h') or {}).get('hands'))
        img = one_frame(p, info, r['f'])
        if img is not None:
            import PIL.Image as I; I.fromarray(img).save(os.path.join(out, f'{name}_{side}.jpg'), quality=85)
    res['flags'] = flags
    res['timing'] = T
    json.dump(res, open(os.path.join(out, f'{name}.json'), 'w'), indent=1, default=str)
    return res


if __name__ == '__main__':
    a = sys.argv[1:]; rot = None
    if '--rot' in a: k = a.index('--rot'); rot = int(a[k + 1]); del a[k:k + 2]
    print(json.dumps(run(a[0], a[1], rot), indent=1, default=str))
