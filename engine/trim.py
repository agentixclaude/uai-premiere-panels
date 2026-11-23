"""Head/tail trim finder. Rule: cut only the start and end pause; the in and out frames
must show mouth CLOSED and eyes OPEN (held for >=3 frames). Usage: python3 trim.py clip.MP4 out_dir"""
import sys, os, json, subprocess, numpy as np
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import face
# Learned from 40 finished client outputs (AI CLONE CLIENT IMP): editors leave ~0.8 s before the first word
# (p10 0.5 / p90 1.6) and ~0.6 s after the last word (p10 0.16 / p90 1.4).
PRE, POST = 0.80, 0.60
PRE_RANGE, POST_RANGE = (0.40, 1.60), (0.15, 1.40)
# Mouth closed: inner-lip gap / face height < 0.008 (closed frames measure 0.001-0.003, open >= 0.01).
# Eyes open: eye opening ratio > 0.18 and > 65% of the clip's own median (open eyes measure 0.23-0.34).
MOUTH_GAP, EAR_MIN, EAR_REL = 0.008, 0.18, 0.65
HOLD=3

def probe(p):
    o=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_streams','-show_format','-of','json',p]))
    s=o['streams'][0]; n,d=map(int,s['r_frame_rate'].split('/'))
    rot=0
    for sd in s.get('side_data_list',[]): rot=int(sd.get('rotation',0))
    w,h=s['width'],s['height']
    if abs(rot)%180==90: w,h=h,w
    return dict(w=w,h=h,fps=n/d,fpsn=n,fpsd=d,dur=float(o['format']['duration']),rot=rot)

def speech_bounds(p):
    a=np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',p,'-vn','-ac','1','-ar','16000','-f','s16le','-']),np.int16).astype(np.float32)/32768
    hop=320; n=len(a)//hop; r=np.sqrt((a[:n*hop].reshape(n,hop)**2).mean(1))+1e-9; db=20*np.log10(r)
    floor=np.percentile(db,10); talk=np.percentile(db,90); thr=max(floor+12,talk-25,-50)
    sp=db>thr; k=int(0.5/0.02)
    run=np.convolve(sp.astype(int),np.ones(k,int),'valid')>=int(k*0.7)
    idx=np.where(run)[0]
    if len(idx)==0: return None
    return dict(start=idx[0]*0.02, end=(idx[-1]+k)*0.02, floor_db=float(floor), thr_db=float(thr))


def frames(p,t0,t1,info,W=1440):
    H=int(round(W*info['h']/info['w']/2))*2
    raw=subprocess.check_output(['ffmpeg','-v','error','-nostdin','-threads','4','-ss',f'{max(t0,0):.3f}','-i',p,'-t',f'{t1-t0:.3f}',
        '-vf',f'scale={W}:{H}','-f','rawvideo','-pix_fmt','rgb24','-'])
    f=np.frombuffer(raw,np.uint8).reshape(-1,H,W,3)
    return f, max(t0,0)

def face_state(img, ear_ref=None):
    st=face.state(img)
    if st is None: return None
    ear_ok = st['ear']>EAR_MIN and (ear_ref is None or st['ear']>EAR_REL*ear_ref)
    st['ok']=bool(st['gap']<MOUTH_GAP and ear_ok)
    return st

def pick(p,info,center,lo,hi,side,speech_edge):
    """Decode the pause window plus ~0.6 s of speech, calibrate 'closed' per face, then pick the
    frame nearest `center` inside [lo,hi] whose mouth is closed and eyes open for HOLD frames."""
    fps=info['fps']
    a=lo if side=='in' else speech_edge-0.6
    b=speech_edge+0.6 if side=='in' else hi
    a=max(0,a); b=min(info['dur'],b)
    face.reset(); fr,t0=frames(p,a,b,info)
    raw=[face.state(x) for x in fr]; ts=[t0+i/fps for i in range(len(fr))]
    gaps=np.array([r['gap'] for r in raw if r]); ears=[r['ear'] for r in raw if r]
    if len(gaps)<5: return None, raw, ts, fr, None
    base=float(np.percentile(gaps,5)); opn=float(np.percentile(gaps,90))
    thr=base+0.35*(opn-base) if opn-base>0.01 else base+0.008
    thr=float(min(max(thr,MOUTH_GAP),0.03)); eref=float(np.median(ears))
    ok=[]
    for r,t in zip(raw,ts):
        good = r is not None and r['gap']<thr and r['ear']>EAR_MIN and r['ear']>EAR_REL*eref and lo<=t<=hi
        if r is not None: r['ok']=bool(good)
        ok.append(good)
    cand=[]
    for i in range(len(fr)):
        if side=='in'  and i+HOLD<=len(fr) and all(ok[i:i+HOLD]): cand.append(i)
        if side=='out' and i-HOLD+1>=0 and all(ok[i-HOLD+1:i+1]): cand.append(i)
    cal=dict(closed_thr=round(thr,4),rest=round(base,4),open=round(opn,4),eye_ref=round(eref,3))
    if not cand:
        lo_f,hi_f=(lo-1.5,hi) if side=='in' else (lo,hi+1.5)   # never inside speech
        pool=[i for i,(r,t) in enumerate(zip(raw,ts)) if r is not None and lo_f<=t<=hi_f and r['ear']>EAR_REL*eref]
        if not pool: return None, raw, ts, fr, cal
        best=min(pool,key=lambda i:(raw[i]['gap'],abs(ts[i]-center)))
        cal['fallback']=True
        return best, raw, ts, fr, cal
    best=min(cand,key=lambda i:abs(ts[i]-center))
    return best, raw, ts, fr, cal

def run(p,out):
    os.makedirs(out,exist_ok=True); name=os.path.splitext(os.path.basename(p))[0]
    info=probe(p); sb=speech_bounds(p); res=dict(clip=name,**info,speech=sb)
    if sb is None: res['flag']='no speech found'; return res
    for side,c,lo,hi in [('in',sb['start']-PRE,sb['start']-PRE_RANGE[1],sb['start']-PRE_RANGE[0]),
                         ('out',sb['end']+POST,sb['end']+POST_RANGE[0],sb['end']+POST_RANGE[1])]:
        lo=max(0,lo); hi=min(info['dur'],hi)
        edge=sb['start'] if side=='in' else sb['end']
        i,st,ts,fr,cal=pick(p,info,c,lo,hi,side,edge)
        if i is None:   # widen once
            lo2=max(0,lo-1.5) if side=='in' else lo; hi2=hi if side=='in' else min(info['dur'],hi+1.5)
            i,st,ts,fr,cal=pick(p,info,c,lo2,hi2,side,edge)
        res[side+'_calibration']=cal
        if i is None:
            res[side]=None; res.setdefault('flags',[]).append(f'{side}: no usable face frame - set manually')
            continue
        if cal and cal.get('fallback'):
            res.setdefault('flags',[]).append(f'{side}: no frame passes the strict rule - best frame used, REVIEW')
        frame=int(round(ts[i]*info['fpsn']/info['fpsd']))
        res[side]=dict(t=ts[i],frame=frame,**st[i])
        import PIL.Image as I; I.fromarray(fr[i]).save(os.path.join(out,f'{name}_{side}.jpg'),quality=88)
    json.dump(res,open(os.path.join(out,f'{name}.json'),'w'),indent=1)
    return res
if __name__=='__main__':
    print(json.dumps(run(sys.argv[1],sys.argv[2]),indent=1))
