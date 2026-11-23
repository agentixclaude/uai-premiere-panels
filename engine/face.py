"""Mouth/eye state from FaceMesh geometry. gap = inner-lip gap / face height; ear = eye opening / eye width.
Small faces (wide shots): find the face with full-range FaceDetection, crop around it, then run FaceMesh on the crop."""
import numpy as np, mediapipe as mp
_fm=_fd=None
def fm():
    global _fm
    if _fm is None: _fm=mp.solutions.face_mesh.FaceMesh(static_image_mode=True,refine_landmarks=True,max_num_faces=1,min_detection_confidence=0.4)
    return _fm
def fd():
    global _fd
    if _fd is None: _fd=mp.solutions.face_detection.FaceDetection(model_selection=1,min_detection_confidence=0.4)
    return _fd
def _measure(rgb):
    r=fm().process(rgb)
    if not r.multi_face_landmarks: return None
    L=r.multi_face_landmarks[0].landmark; h,w=rgb.shape[:2]
    P=lambda i: np.array([L[i].x*w,L[i].y*h])
    fh=np.linalg.norm(P(10)-P(152))+1e-6
    gap=np.linalg.norm(P(13)-P(14))/fh
    el=np.linalg.norm(P(159)-P(145))/(np.linalg.norm(P(33)-P(133))+1e-6)
    er=np.linalg.norm(P(386)-P(374))/(np.linalg.norm(P(362)-P(263))+1e-6)
    return dict(gap=float(gap),ear=float(min(el,er)),ear_l=float(el),ear_r=float(er),fh=float(fh))
_box=None
def state(rgb):
    global _box
    s=_measure(rgb)
    if s is not None and s['fh']>=80: return s
    h,w=rgb.shape[:2]
    d=fd().process(rgb)
    if d.detections:
        b=d.detections[0].location_data.relative_bounding_box
        cx,cy,bw,bh=(b.xmin+b.width/2)*w,(b.ymin+b.height/2)*h,b.width*w,b.height*h
        _box=(cx,cy,max(bw,bh))
    if _box is None: return s
    cx,cy,sz=_box; half=int(sz*1.6)
    x0,y0=max(0,int(cx-half)),max(0,int(cy-half)); x1,y1=min(w,int(cx+half)),min(h,int(cy+half))
    crop=np.ascontiguousarray(rgb[y0:y1,x0:x1])
    if crop.size==0: return s
    import PIL.Image as I
    up=np.asarray(I.fromarray(crop).resize((480,int(480*crop.shape[0]/crop.shape[1])),I.BICUBIC))
    s2=_measure(up)
    return s2 if s2 is not None else s
def reset(): 
    global _box; _box=None
