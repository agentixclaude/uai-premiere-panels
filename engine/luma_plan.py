"""UAI Luma Cut — Claude mode. Turns the panel's luma_request.json into luma_plan.json.

For every clip: find the first/last word (audio), then the nearest frame with the mouth closed and the eyes open
(trim.py), then match the grade per clip (grade_analyze.py: skin brightness/colour, highlights).
Resumable: each clip's result is cached, so run it again until it prints "plan written".

Usage (inside Claude's workspace on the Mac, where connected folders sit under ~/mnt/):
  python3 luma_plan.py --setup                      # once per session: installs mediapipe if missing
  python3 luma_plan.py "<path to luma_request.json>" [--budget 150]
"""
import os, sys, json, time, glob, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEPS = os.environ.get('LUMACUT_DEPS', os.path.expanduser('~/.lumacut_deps'))
for p in (DEPS, '/tmp/mp10', HERE):
    if p not in sys.path: sys.path.insert(0, p)
HOUSE = dict(Exposure=0.0, Contrast=19.0, Highlights=8.0, Shadows=-6.0, Saturation=108.0, Tint=2.0, Temperature=0.0)
PRE, POST = 0.80, 0.60


def setup():
    try:
        import mediapipe  # noqa: F401
        print('mediapipe ready'); return
    except Exception:
        pass
    os.makedirs(DEPS, exist_ok=True)
    cmd = [sys.executable, '-m', 'pip', 'install', '--quiet', '--target', DEPS, 'mediapipe==0.10.14', 'numpy<2', 'pillow']
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


def main(request_path, budget):
    import trim, grade_analyze
    req = json.load(open(request_path))
    cdir = client_dir_for(request_path, req)
    work = os.path.expanduser(f"~/.lumacut_work/{req['client']}_{req['requestId']}")
    os.makedirs(work, exist_ok=True)
    t0, done, left = time.time(), 0, 0
    for c in req['clips']:
        name = os.path.splitext(c['file'])[0]
        cache = os.path.join(work, name + '.json')
        if os.path.exists(cache): done += 1; continue
        if time.time() - t0 > budget: left += 1; continue
        src = os.path.join(cdir, c['rel'])
        try:
            res = trim.run(src, work)
        except Exception as e:
            res = dict(clip=name, error=str(e)[:300])
        json.dump(res, open(cache, 'w'), indent=1)
        done += 1
        print(json.dumps(dict(clip=c['file'], done=done, total=len(req['clips']))), flush=True)
    if left:
        print(json.dumps(dict(status='running', done=done, total=len(req['clips']), remaining=left))); return
    grades, _ = grade_analyze.run(work)
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
        g = grades.get(name, {}).get('grade', HOUSE)
        clips.append(dict(file=c['file'], path=c['path'], w=c['w'], h=c['h'], rot=c['rot'], fps=fps, frames=frames,
                          **{'in': fi}, out=fo, flag='; '.join(flags), grade=g))
    plan = dict(version=1, source='claude', requestId=req['requestId'], client=req['client'],
                createdAt=time.strftime('%Y-%m-%dT%H:%M:%S'), engine='audio + face (mouth closed, eyes open) + skin grade', clips=clips)
    out = os.path.join(os.path.dirname(os.path.abspath(request_path)), 'luma_plan.json')
    write_atomic(out, plan)
    print(json.dumps(dict(status='plan written', path=out, clips=len(clips), flagged=sum(1 for x in clips if x['flag']))))


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--setup' in args: setup(); args = [a for a in args if a != '--setup']
    if args:
        b = 150.0
        if '--budget' in args: i = args.index('--budget'); b = float(args[i + 1]); del args[i:i + 2]
        main(args[0], b)
