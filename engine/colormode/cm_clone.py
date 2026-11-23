#!/usr/bin/env python3
"""Copy a Color Mode adjustment (Color Shift on skin) from one clip to others inside a Premiere 2027 .prproj,
then set each clip's skin Hue / Sat / Lum Shift. Same result as the Color tab's "Paste Grade > Paste and Replace",
but scriptable. Premiere's scripting cannot create or copy Color Mode effects, so this edits the saved project.

CLOSE the project in Premiere first. A backup is written next to the project as <name>.before-colormode.prproj.

  python3 cm_clone.py <project.prproj> --from C0006.MP4 --to C0002.MP4,C0007.MP4 [--hue 4] [--sat 0] [--lum 6]
  python3 cm_clone.py <project.prproj> --plan groups.json     # [{"from":..,"to":[..],"hue":..,"lum":..}, ...]

Only body clips (the enabled piece that carries the S-Log Lumetri) are touched. A clip that already has a
Color Mode adjustment gets it replaced. The copy is inserted first in the clip's effect list, as Premiere does.
Dial values are the numbers shown in the Color tab (stored value x 100); they go on the first colour point
(the first colour picked with the eyedropper, normally skin)."""
import sys, os, re, gzip, json, struct, base64, uuid, shutil

OBJ_RE = re.compile(r'\n\t<(\w+) (Object(?:U)?ID)="([^"]+)"([^>]*)>(.*?)\n\t</\1>', re.S)
REF_RE = re.compile(r'(Object(?:U)?Ref)="([^"]+)"')
CURVES = {'sat': 3, 'hue': 8, 'lum': 13}


def load(path):
    s = gzip.open(path).read().decode('utf8')
    objs = {}
    for m in OBJ_RE.finditer(s):
        objs[m.group(3)] = dict(tag=m.group(1), kind=m.group(2), attrs=m.group(4), body=m.group(5), text=m.group(0))
    parent = {}
    for oid, o in objs.items():
        for _, r in REF_RE.findall(o['body']):
            parent.setdefault(r, []).append(oid)
    return s, objs, parent


def subtree(objs, root):
    seen, st = [], [root]
    while st:
        o = st.pop()
        if o in seen or o not in objs: continue
        seen.append(o)
        st += [r for _, r in REF_RE.findall(objs[o]['body'])]
    return seen


def clip_name(objs, track_item):
    m = re.search(r'<SubClip ObjectRef="([^"]+)"', objs[track_item]['body'])
    if not m: return None
    n = re.search(r'<Name>([^<]*)', objs[m.group(1)]['body'])
    return n.group(1) if n else None


def chain_of(objs, track_item):
    for _, r in REF_RE.findall(objs[track_item]['body']):
        if objs.get(r, {}).get('tag') == 'VideoComponentChain' and '<ComponentChain' in objs[r]['body']:
            return r
    return None


def components(objs, chain):
    return re.findall(r'<Component Index="(\d+)" ObjectRef="([^"]+)"/>', objs[chain]['body'])


def is_colormode(objs, comp):
    return objs[comp]['tag'] == 'CompoundComponent' and any('AE.ADBE Color Shift' in objs[x]['body'] for x in subtree(objs, comp))


def is_lumetri(objs, comp):
    return 'AE.ADBE Lumetri' in objs[comp]['body']


def body_items(objs):
    """clip name -> (track item, chain) for every body piece (chain holds a Lumetri)."""
    out = {}
    for oid, o in objs.items():
        if o['tag'] != 'VideoClipTrackItem': continue
        ch = chain_of(objs, oid)
        if not ch: continue
        comps = [c for _, c in components(objs, ch)]
        if any(is_lumetri(objs, c) for c in comps):
            out.setdefault(clip_name(objs, oid), []).append((oid, ch))
    return out


def set_curve(text, value):
    m = re.search(r'(<StartKeyframeValue Encoding="base64"[^>]*>)([^<]*)(<)', text)
    if not m: return text, False
    bb = bytearray(base64.b64decode(m.group(2).strip()))
    if len(bb) < 24 or struct.unpack('<q', bb[16:24])[0] < 1: return text, False
    bb[32:40] = struct.pack('<d', value / 100.0)
    return text[:m.start(2)] + base64.b64encode(bytes(bb)).decode() + '\n\t\t' + text[m.end(2):], True


def run(path, jobs):
    s, objs, parent = load(path)
    items = body_items(objs)
    ints = [int(k) for k in objs if k.isdigit()]
    next_id = [max(ints) + 1 if ints else 1]
    new_texts, chain_edits, report = [], {}, []

    def fresh(kind):
        if kind == 'ObjectID':
            v = str(next_id[0]); next_id[0] += 1; return v
        return str(uuid.uuid4())

    for job in jobs:
        src = job['from']
        if src not in items: raise SystemExit(f'{src}: no graded body clip with that name')
        _, src_chain = items[src][0]
        roots = [c for _, c in components(objs, src_chain) if is_colormode(objs, c)]
        if not roots: raise SystemExit(f'{src}: has no Color Mode adjustment to copy')
        root = roots[0]
        tree = subtree(objs, root)
        for name in job['to']:
            for ti, ch in items.get(name, []):
                idmap = {o: fresh(objs[o]['kind']) for o in tree}
                curve_vals = {}
                for o in tree:
                    ob = objs[o]
                    body = REF_RE.sub(lambda m: f'{m.group(1)}="{idmap.get(m.group(2), m.group(2))}"', ob['body'])
                    txt = f'\n\t<{ob["tag"]} {ob["kind"]}="{idmap[o]}"{ob["attrs"]}>{body}\n\t</{ob["tag"]}>'
                    new_texts.append((idmap[o], txt))
                # chain: drop an existing Color Mode adjustment, put the copy first
                cur = chain_edits.get(ch, [c for _, c in components(objs, ch)])
                kept = [c for c in cur if not (c in objs and is_colormode(objs, c))]
                chain_edits[ch] = [idmap[root]] + kept
                # unique component ID inside the target chain
                used = [int(x) for c in kept if c in objs for x in re.findall(r'<Component Version="\d+">\s*<Unique>[^<]*</Unique>\s*<ID>(\d+)</ID>', objs[c]['body'])]
                job.setdefault('_roots', []).append((name, idmap[root], max(used + [0]) + 1, idmap, tree))
                report.append(f'{name}: Color Mode copied from {src}' + (' (replaced its own)' if len(kept) < len(cur) else ''))
            if name not in items: report.append(f'{name}: no graded body clip, skipped')

    # write: rewrite chains, append objects, then values
    out = s
    for ch, comps in chain_edits.items():
        body = objs[ch]['body']
        block = ''.join(f'\n\t\t\t\t<Component Index="{i}" ObjectRef="{c}"/>' for i, c in enumerate(comps))
        nb = re.sub(r'(<Components Version="1">)(.*?)(\n\t\t\t</Components>)', lambda m: m.group(1) + block + m.group(3), body, count=1, flags=re.S)
        assert out.count(objs[ch]['text']) == 1
        out = out.replace(objs[ch]['text'], objs[ch]['text'].replace(body, nb), 1)
    texts = dict(new_texts)
    for job in jobs:
        for name, new_root, comp_id, idmap, tree in job.get('_roots', []):
            t = texts[new_root]
            texts[new_root] = re.sub(r'(<Component Version="\d+">\s*<Unique>[^<]*</Unique>\s*<ID>)\d+(</ID>)', lambda m: f'{m.group(1)}{comp_id}{m.group(2)}', t, count=1)
            # first Color Shift filter in the copy -> its Sat/Hue/Lum curve params
            filt = next((idmap[o] for o in tree if objs[o]['tag'] == 'VideoFilterComponent' and 'AE.ADBE Color Shift' in objs[o]['body']), None)
            if filt is None: continue
            ps = dict((int(i), r) for i, r in re.findall(r'<Param Index="(\d+)" ObjectRef="([^"]+)"/>', texts[filt]))
            done = []
            for k, idx in CURVES.items():
                if k not in job or job[k] is None: continue
                texts[ps[idx]], ok = set_curve(texts[ps[idx]], float(job[k]))
                done.append(f'{k} {float(job[k]):+g}' if ok else f'{k}: no colour point to set')
            report.append(f'{name}: ' + ', '.join(done) if done else f'{name}: values kept from source')
    tail = out.rfind('\n</PremiereData>')
    if tail < 0: raise SystemExit('Unexpected project format (no </PremiereData>)')
    out = out[:tail] + ''.join(texts[k] for k, _ in new_texts) + out[tail:]
    backup = re.sub(r'\.prproj$', '', path) + '.before-colormode.prproj'
    if not os.path.exists(backup): shutil.copy2(path, backup)
    with gzip.open(path, 'wb') as g: g.write(out.encode('utf8'))
    print('\n'.join(report)); print(f'saved; backup: {backup}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) < 2: print(__doc__); sys.exit(1)
    proj = a[0]
    if '--plan' in a:
        jobs = json.load(open(a[a.index('--plan') + 1]))
    else:
        g = lambda k: float(a[a.index('--' + k) + 1]) if '--' + k in a else None
        jobs = [dict(**{'from': a[a.index('--from') + 1]}, to=a[a.index('--to') + 1].split(','), hue=g('hue'), sat=g('sat'), lum=g('lum'))]
    run(proj, jobs)
