"""Per-clip Lumetri values (on top of the house S-Log Lumetri + ALEXA LUT look).
Measures skin (cheeks/forehead from FaceMesh) and highlights on the in/out frames, then normalises every clip of a
client to that client's median skin brightness and colour. House base = medians of the team's past projects."""
import sys,os,json,glob,numpy as np
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import face
from PIL import Image
HOUSE=dict(Exposure=0.0,Contrast=19.0,Highlights=8.0,Shadows=-6.0,Saturation=108.0,Tint=2.0,Temperature=0.0)
SKIN_IDX=[50,280,101,330,151,9,108,337,205,425]          # cheeks + forehead
def slog3_lin(x):
    cv=x*1023.0
    return np.where(cv>=171.21,(10**((cv-420.0)/261.5))*0.19-0.01,(cv-95.0)*0.01125/(171.21-95.0))
def measure(img):
    rgb=np.asarray(img.convert('RGB')); h,w=rgb.shape[:2]
    lum=rgb.mean(-1)/255.0; p99=float(np.percentile(lum,99.5))
    r=face.fm().process(rgb)
    if not r.multi_face_landmarks:            # wide shot: find the face, crop, upscale, measure there
        d=face.fd().process(rgb)
        if not d.detections: return dict(p99=p99)
        b=d.detections[0].location_data.relative_bounding_box
        cx,cy,sz=(b.xmin+b.width/2)*w,(b.ymin+b.height/2)*h,max(b.width*w,b.height*h)
        x0,y0=max(0,int(cx-1.6*sz)),max(0,int(cy-1.6*sz)); x1,y1=min(w,int(cx+1.6*sz)),min(h,int(cy+1.6*sz))
        rgb=np.asarray(Image.fromarray(rgb[y0:y1,x0:x1]).resize((480,int(480*(y1-y0)/(x1-x0))),Image.BICUBIC)); h,w=rgb.shape[:2]
        r=face.fm().process(rgb)
        if not r.multi_face_landmarks: return dict(p99=p99)
    L=r.multi_face_landmarks[0].landmark; fh=abs(L[152].y-L[10].y)*h; rad=max(3,int(fh*0.04))
    px=[]
    for i in SKIN_IDX:
        x,y=int(L[i].x*w),int(L[i].y*h)
        px.append(rgb[max(0,y-rad):y+rad,max(0,x-rad):x+rad].reshape(-1,3))
    s=np.median(np.concatenate(px),0)/255.0
    lin=np.maximum(slog3_lin(s),1e-4)
    return dict(p99=p99,skin_lin=lin.tolist(),skin_Y=float(lin@[0.2126,0.7152,0.0722]))
def run(client_dir):
    rows={}
    for f in sorted(glob.glob(client_dir+'/*.json')):
        d=json.load(open(f)); n=d.get('clip')
        if not n or 'error' in d: continue
        ms=[measure(Image.open(p)) for p in (f'{client_dir}/{n}_in.jpg',f'{client_dir}/{n}_out.jpg') if os.path.exists(p)]
        sk=[m for m in ms if 'skin_lin' in m]
        rows[n]=dict(p99=max([m['p99'] for m in ms] or [0]),
                     skin=np.median([m['skin_lin'] for m in sk],0).tolist() if sk else None,
                     Y=float(np.median([m['skin_Y'] for m in sk])) if sk else None)
    Ys=[r['Y'] for r in rows.values() if r['Y']]; refY=float(np.median(Ys)) if Ys else None
    bg=[np.log(r['skin'][2]/r['skin'][1]) for r in rows.values() if r['skin']]
    rg=[np.log(r['skin'][0]/r['skin'][1]) for r in rows.values() if r['skin']]
    ref_bg=float(np.median(bg)) if bg else 0; ref_rg=float(np.median(rg)) if rg else 0
    out={}
    for n,r in rows.items():
        g=dict(HOUSE)
        if r['Y'] and refY:
            g['Exposure']=round(float(np.clip(0.7*np.log2(refY/r['Y']),-1.0,1.0)),2)
        if r['skin']:
            dbg=np.log(r['skin'][2]/r['skin'][1])-ref_bg      # >0 = bluer than reference -> warm it
            drg=np.log(r['skin'][0]/r['skin'][1])-ref_rg      # >0 = more magenta/red than reference -> tint toward green
            g['Temperature']=round(float(np.clip(45*dbg,-15,15)),1)
            g['Tint']=round(float(np.clip(HOUSE['Tint']-30*drg,-10,10)),1)
        if r['p99']>0.90: g['Highlights']=-25.0
        elif r['p99']>0.80: g['Highlights']=-10.0
        out[n]=dict(grade=g,measure=r)
    return out,dict(refY=refY,ref_bg=ref_bg,ref_rg=ref_rg)
if __name__=='__main__':
    RUN=os.path.expanduser('~/mnt/Log Color Grading/_runs')
    for c in sys.argv[1:]:
        o,ref=run(f'{RUN}/{c}/trim_v2'); json.dump(dict(ref=ref,clips=o),open(f'{RUN}/{c}/grades.json','w'),indent=1)
        print(c,'ref',{k:round(v,4) for k,v in ref.items() if v is not None})
        for n,v in o.items(): print('  ',n,{k:v['grade'][k] for k in ('Exposure','Temperature','Tint','Highlights')},'Y',v['measure']['Y'] and round(v['measure']['Y'],3),'p99',round(v['measure']['p99'],2))
