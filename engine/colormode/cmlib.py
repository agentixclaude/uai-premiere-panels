import gzip,re,base64,struct
def load(path):
    s=gzip.open(path).read().decode('utf8')
    objs={}
    for m in re.finditer(r'\n\t<(\w+) Object(U?ID)="([^"]+)"[^>]*>(.*?)\n\t</\1>', s, re.S):
        objs[m.group(3)]=(m.group(1),m.group(4))
    parent={}
    for oid,(tag,body) in objs.items():
        for r in re.findall(r'Object(?:U)?Ref="([^"]+)"',body): parent.setdefault(r,[]).append(oid)
    return s,objs,parent
def params(body): return re.findall(r'<Param Index="(\d+)" ObjectRef="(\d+)"/>',body)
def blob(b):
    m=re.search(r'<StartKeyframeValue Encoding="base64"[^>]*>([^<]*)<',b)
    return base64.b64decode(m.group(1).strip()) if m else b''
def curve(bb):
    # header: 8 zero, int64 pid, int64 npoints, then per point 8 doubles, trailing byte(s)
    if len(bb)<24: return None
    pid,n=struct.unpack('<qq',bb[8:24]); pts=[]
    off=24
    for k in range(n):
        if off+64>len(bb): break
        pts.append(struct.unpack('<8d',bb[off:off+64])); off+=64
    return dict(pid=pid,n=n,pts=pts,tail=bb[off:].hex())
def swatches(bb):
    sel=struct.unpack('<4f',bb[8:24]); n=struct.unpack('<q',bb[24:32])[0]; out=[]; off=32
    for k in range(n):
        rgba=struct.unpack('<4f',bb[off:off+16]); flag=bb[off+16]; out.append((tuple(round(x,3) for x in rgba),flag)); off+=17
    return tuple(round(x,3) for x in sel),out,bb[off:].hex()
def up(objs,parent,oid,stop=('VideoClipTrackItem',)):
    chain=[oid]
    while True:
        ps=parent.get(chain[-1],[])
        if not ps: break
        chain.append(ps[0])
        if objs[ps[0]][0] in stop: break
    return chain
