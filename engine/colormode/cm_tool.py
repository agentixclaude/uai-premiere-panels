#!/usr/bin/env python3
"""Color Mode "Color Shift" reader / writer for Premiere 2027 project files.

Premiere gives scripts no access to the Color Mode effect, so this works on the saved .prproj
(gzip XML). CLOSE the project in Premiere before writing.

  python3 cm_tool.py read  <project.prproj>
  python3 cm_tool.py set   <project.prproj> --clip C0002.MP4 [--hue 5] [--sat 2] [--lum -1.5]

Values are the numbers shown on the dials (stored value x 100). `set` changes the FIRST colour point
of each curve (the first colour picked with the eyedropper, normally skin) on clips that already
have a Color Mode adjustment with that curve. A backup goes to ./backups/ first.
Positive Hue Shift on skin moves it toward red/pink; negative toward yellow.
"""
import sys, os, re, gzip, struct, base64, shutil, time, colorsys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cmlib import load, params, blob, curve, swatches, up

CURVES = {'sat': 3, 'hue': 8, 'lum': 13}     # param index inside the "AE.ADBE Color Shift" filter

def filters(objs, parent):
    out = []
    for o, (t, b) in objs.items():
        if t == 'VideoFilterComponent' and 'AE.ADBE Color Shift' in b:
            ti = up(objs, parent, o)[-1]; tb = objs[ti][1]
            m = re.search(r'<SubClip ObjectRef="(\d+)"', tb)
            name = re.search(r'<Name>([^<]*)', objs[m.group(1)][1]).group(1) if m else '?'
            out.append((name, o))
    return out

def read(path):
    s, objs, parent = load(path)
    rows = filters(objs, parent)
    if not rows: print('No Color Mode adjustments in this project.'); return
    print(f'{"clip":16} {"first colour (hue deg)":24} {"Hue":>7} {"Sat":>7} {"Lum":>7}   other points')
    for name, f in rows:
        ps = dict((int(i), r) for i, r in params(objs[f][1]))
        try:
            _, sw, _ = swatches(blob(objs[ps[0]][1])); c = sw[0][0][:3]
            col = f'{round(colorsys.rgb_to_hsv(*c)[0]*360)} deg'
        except Exception: col = '-'
        vals, extra = {}, []
        for k, idx in CURVES.items():
            c = curve(blob(objs[ps[idx]][1]))
            pts = c['pts'] if c and len(c['pts']) == c['n'] else []
            vals[k] = f'{pts[0][1]*100:+.2f}' if pts else '-'
            extra += [f'{k}@{p[0]:.3f}={p[1]*100:+.1f}' for p in pts[1:]]
        print(f'{name:16} {col:24} {vals["hue"]:>7} {vals["sat"]:>7} {vals["lum"]:>7}   {" ".join(extra)}')

def write(path, clip, new):
    s, objs, parent = load(path)
    out, done = s, []
    for name, f in filters(objs, parent):
        if name.lower() != clip.lower(): continue
        ps = dict((int(i), r) for i, r in params(objs[f][1]))
        for k, v in new.items():
            body = objs[ps[CURVES[k]]][1]
            m = re.search(r'(<StartKeyframeValue Encoding="base64"[^>]*>)([^<]*)(<)', body)
            bb = bytearray(base64.b64decode(m.group(2).strip())) if m else bytearray()
            c = curve(bytes(bb))
            if not c or not c['pts']:
                print(f'  {name}: no {k} point yet - pick the colour with the eyedropper in Premiere first'); continue
            bb[32:40] = struct.pack('<d', v / 100.0)
            nb = body[:m.start(2)] + base64.b64encode(bytes(bb)).decode() + '\n\t\t' + body[m.end(2):]
            assert out.count(body) == 1
            out = out.replace(body, nb, 1); done.append(f'{k}={v:+g}')
    if not done: print('Nothing changed.'); return
    bdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backups'); os.makedirs(bdir, exist_ok=True)
    shutil.copy2(path, os.path.join(bdir, time.strftime('%Y%m%d-%H%M%S_') + os.path.basename(path)))
    with gzip.open(path, 'wb') as g: g.write(out.encode('utf8'))
    print(f'{clip}: wrote {", ".join(done)}')

if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == 'read': read(a[1])
    elif len(a) >= 4 and a[0] == 'set':
        new = {k: float(a[a.index('--' + k) + 1]) for k in CURVES if '--' + k in a}
        write(a[1], a[a.index('--clip') + 1], new)
    else: print(__doc__)
