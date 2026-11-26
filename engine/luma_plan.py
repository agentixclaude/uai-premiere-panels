"""UAI Luma Cut — Claude mode. Turns the panel's luma_request.json into luma_plan.json.

For every clip: find the first/last word (audio), then the nearest frame with the mouth closed and the eyes open
(trim.py), then match the grade per clip (grade_analyze.py: skin brightness/colour, highlights).
Resumable: each clip's result is cached, so run it again until it prints "plan written".

Usage (inside Claude's workspace on the Mac, where connected folders sit under ~/mnt/):
  python3 luma_plan.py --setup                      # once per session: installs mediapipe if missing
  python3 luma_plan.py "<path to luma_request.json>" [--budget 150]
  python3 luma_plan.py --memory "<path to grade_memory.jsonl>"   # what reviewers changed after past builds
"""
import os, sys, json, time, glob, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEPS = os.environ.get('LUMACUT_DEPS', os.path.expanduser('~/.lumacut_deps'))
for p in (DEPS, '/tmp/mp10', HERE):
    if p not in sys.path: sys.path.insert(0, p)
HOUSE = dict(Exposure=0.0, Contrast=19.0, Highlights=8.0, Shadows=-6.0, Saturation=108.0, Tint=2.0, Temperature=0.0)
PRE, POST = 0.80, 0.60   # fallback only, when a clip has no face result
WORKERS = max(1, min(3, (os.cpu_count() or 2) // 2))


def setup():
    try:
        import mediapipe  # noqa: F401
        print('mediapipe ready'); return
    except Exception:
        pass
    os.makedirs(DEPS, exist_ok=True)
    cmd = [sys.executable, '-m', 'pip', 'install', '--quiet', '--target', DEPS, 'mediapipe==0.10.14', 'numpy<2', 'pillow', 'faster-whisper']
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        cmd.insert(4, '--break-system-packages'); r = subprocess.run(cmd, capture_output=True, text=True)
    print('mediapipe installed' if r.returncode == 0 else 'install failed: ' + r.stderr[-400:])


def client_dir_for(request_path, req):
    d = os.path.dirname(os.path.abspath(request_path))
    for _ in [p for p in str(req.get('projRel', 'Project File')).split('/') if p]:
        d = os.path.dirname(d)
    return d


def write_atomic(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.luma_plan_', suffix='.tmp')
    with os.fdopen(fd, 'w') as f: json.dump(data, f, indent=1)
    os.replace(tmp, path)


def speech_frames(res, fps, frames):
    sb = res.get('speech')
    if not sb: return 0, frames - 1
    return max(0, round((sb['start'] - PRE) * fps)), min(frames - 1, round((sb['end'] + POST) * fps))


PRIORS = os.path.expanduser('~/UAI Luma Cut/learning/grade_priors.json')


def _priors():
    for p in (PRIORS, os.path.join(os.path.expanduser('~'), 'mnt', 'UAI Luma Cut', 'learning', 'grade_priors.json'), os.path.join(HERE, 'grade_priors.json')):
        try: return json.load(open(p))
        except Exception: pass
    return None


def _group(name):
    n = name.upper()
    return 'outdoor' if n.startswith('VG') else 'greenscreen' if n.startswith('CAM') else 'office'


def apply_priors(name, g, pri):
    """Starting point learned from past corrections (not a benchmark): offsets, a fixed look, caps."""
    if not pri: return g
    rule = pri.get('groups', {}).get(_group(name))
    if not rule: return g
    g = dict(g)
    for k, d in rule.get('offset', {}).items(): g[k] = round(g.get(k, HOUSE.get(k, 0)) + d, 2)
    for k, v in rule.get('set', {}).items(): g[k] = v
    for k, (lo, hi) in rule.get('cap', {}).items():
        if k in g: g[k] = min(hi, max(lo, g[k]))
    return g


def _analyse(src, work, rot=None):
    import trim
    return trim.run(src, work, rot)


def proxy_for(cdir, c):
    """<client>/Proxies/<name>_Proxy.mov (frame-exact 1080p copy) when it exists: ~2.5x faster than the 8K original."""
    rel = os.path.dirname(c.get('rel', c['file'])).split(os.sep)[1:]
    p = os.path.join(cdir, 'Proxies', *rel, os.path.splitext(c['file'])[0] + '_Proxy.mov')
    return p if os.path.exists(p) and os.path.getsize(p) > 0 else None


def main(request_path, budget):
    import grade_analyze
    req = json.load(open(request_path))
    cdir = client_dir_for(request_path, req)
    work = os.path.expanduser(f"~/.lumacut_work/{req['client']}_{req['requestId']}")
    os.makedirs(work, exist_ok=True)
    t0, done, left = time.time(), 0, 0
    todo = []
    for c in req['clips']:
        name = os.path.splitext(c['file'])[0]
        if os.path.exists(os.path.join(work, name + '.json')): done += 1
        else: todo.append(c)
    # clips are analysed WORKERS at a time; a new batch starts only while the time budget lasts
    from concurrent.futures import ProcessPoolExecutor
    with ProcessPoolExecutor(WORKERS) as ex:
        while todo and time.time() - t0 <= budget:
            batch, todo = todo[:WORKERS], todo[WORKERS:]
            futs = [(c, ex.submit(_analyse, proxy_for(cdir, c) or os.path.join(cdir, c['rel']), work, c.get('rot'))) for c in batch]
            for c, f in futs:
                name = os.path.splitext(c['file'])[0]
                try: res = f.result()
                except Exception as e: res = dict(clip=name, error=str(e)[:300])
                json.dump(res, open(os.path.join(work, name + '.json'), 'w'), indent=1, default=str)
                done += 1
                print(json.dumps(dict(clip=c['file'], done=done, total=len(req['clips']))), flush=True)
    left = len(todo)
    if left:
        print(json.dumps(dict(status='running', done=done, total=len(req['clips']), remaining=left))); return
    grades, _ = grade_analyze.run(work)
    pri = _priors()
    clips = []
    for c in req['clips']:
        name = os.path.splitext(c['file'])[0]
        res = json.load(open(os.path.join(work, name + '.json')))
        fps, frames = float(c['fps']), int(c['frames'])
        flags = []
        if res.get('error'): flags.append('analysis failed: ' + res['error'][:80])
        if res.get('flag'): flags.append(res['flag'])
        flags += res.get('flags', [])
        si, so = speech_frames(res, fps, frames)
        fi = res['in']['frame'] if isinstance(res.get('in'), dict) else si
        fo = res['out']['frame'] if isinstance(res.get('out'), dict) else so
        fi, fo = max(0, min(frames - 1, int(fi))), max(0, min(frames - 1, int(fo)))
        if fo <= fi: fi, fo = 0, frames - 1; flags.append('trim failed - set IN/OUT by hand')
        # engine v3: OUT used as found (the 'OUT 0.5 s earlier' rule is withdrawn: on AC#13 the user moved OUTs later)
        g = grades.get(name, {}).get('grade', HOUSE)
        g = apply_priors(name, g, pri)
        if abs(g.get('Exposure', 0)) > 0.6:
            flags.append(f"exposure {g['Exposure']:+.2f} limited to {0.6 if g['Exposure'] > 0 else -0.6:+.1f}; Grade > Check light & colour sets the final value")
            g['Exposure'] = 0.6 if g['Exposure'] > 0 else -0.6
        clips.append(dict(file=c['file'], path=c['path'], w=c['w'], h=c['h'], rot=c['rot'], fps=fps, frames=frames,
                          **{'in': fi}, out=fo, flag='; '.join(flags), grade=g, group=_group(name)))
    plan = dict(version=1, source='claude', requestId=req['requestId'], client=req['client'],
                createdAt=time.strftime('%Y-%m-%dT%H:%M:%S'), engine='engine v3: transcript openers + count-in / closing-remark drop; face, mouth, teeth, eyes, hands, still held 3 frames; no IN into the speech; grade priors once, exposure limit +-0.6', clips=clips)
    out = os.path.join(os.path.dirname(os.path.abspath(request_path)), 'luma_plan.json')
    write_atomic(out, plan)
    print(json.dumps(dict(status='plan written', path=out, clips=len(clips), flagged=sum(1 for x in clips if x['flag']))))


def memory_summary(path):
    """Average correction per area/field and camera from confirmed reviews, plus the reviewers' notes."""
    rows = [json.loads(l) for l in open(path) if l.strip()]
    agg = {}
    for r in rows:
        for c in r.get('changes', []):
            for it in c.get('items', []):
                k = (it['area'], it['field'], c.get('camera', ''))
                agg.setdefault(k, []).append(it['to'] - it['from'])
    print(f'{len(rows)} confirmed reviews')
    for (area, field, cam), d in sorted(agg.items(), key=lambda x: -len(x[1])):
        print(f'  {area:12} {field:12} {cam:6} n={len(d):2}  mean {sum(d)/len(d):+.2f}  range {min(d):+.2f}..{max(d):+.2f}')
    for r in rows[-10:]:
        if r.get('note'): print(f"  note ({r.get('client')}, {r.get('date','')[:10]}): {r['note']}")


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--memory' in args:
        i = args.index('--memory'); memory_summary(args[i + 1]); del args[i:i + 2]
    if '--setup' in args: setup(); args = [a for a in args if a != '--setup']
    if args:
        b = 150.0
        if '--budget' in args: i = args.index('--budget'); b = float(args[i + 1]); del args[i:i + 2]
        main(args[0], b)
