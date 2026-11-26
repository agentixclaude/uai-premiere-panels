"""Face, mouth, teeth, eyes and hands per frame (engine v3, 2026-11-26).

state(rgb) -> dict | None
  gap   inner-lip gap / face height            (mouth open)
  teeth share of bright, low-saturation pixels inside the inner-lip outline (teeth showing)
  ear   eye opening / eye width, the smaller eye (eyes closed / blinking)
  yaw   nose offset from the eye centre / eye distance (0 = toward the camera)
  cx, cy, fh  face centre and height in frame pixels (moving / standing up)
hands(rgb, st) -> dict: wrists from Pose. raised = a visible wrist above the lower chest; lw/rw positions for movement.
Small faces (wide shots): full-range FaceDetection, crop around the face, FaceMesh on the upscaled crop."""
import numpy as np, mediapipe as mp
_fm = _fd = _pose = None

INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]
OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]


def fm():
    global _fm
    if _fm is None: _fm = mp.solutions.face_mesh.FaceMesh(static_image_mode=True, refine_landmarks=True, max_num_faces=1, min_detection_confidence=0.4)
    return _fm


def fd():
    global _fd
    if _fd is None: _fd = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.4)
    return _fd


def pose():
    global _pose
    if _pose is None: _pose = mp.solutions.pose.Pose(static_image_mode=True, model_complexity=1, min_detection_confidence=0.4)  # "full" ships inside mediapipe (no download)
    return _pose


def _poly_mask(pts, h, w):
    import PIL.Image as I, PIL.ImageDraw as D
    m = I.new('L', (w, h), 0); D.Draw(m).polygon([tuple(p) for p in pts], fill=1)
    return np.asarray(m, bool)


def _teeth(rgb, pin, pout):
    """Share of the open mouth that is teeth-coloured (bright, low saturation), measured against the lips."""
    x0, y0 = np.floor(pout.min(0)).astype(int) - 2; x1, y1 = np.ceil(pout.max(0)).astype(int) + 2
    h, w = rgb.shape[:2]; x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(w, x1), min(h, y1)
    if x1 - x0 < 4 or y1 - y0 < 4: return 0.0, 0.0
    sub = rgb[y0:y1, x0:x1].astype(np.float32) / 255
    off = np.array([x0, y0])
    mi = _poly_mask(pin - off, y1 - y0, x1 - x0); mo = _poly_mask(pout - off, y1 - y0, x1 - x0) & ~mi
    area = float(mi.sum())
    if area < 6 or mo.sum() < 6: return 0.0, area
    mx, mn = sub.max(2), sub.min(2); sat = (mx - mn) / (mx + 1e-6)
    lip_v, lip_s = float(np.median(mx[mo])), float(np.median(sat[mo]))
    # S-Log is flat: teeth are about as bright as the lips but less saturated; the open mouth is darker
    t = (mx >= lip_v * 0.97) & (sat <= lip_s * 0.92) & mi
    return float(t.sum() / area), area


def _measure(rgb, x0=0.0, y0=0.0, s=1.0):
    """s, x0, y0 map image pixels back to the frame: frame = x0 + img / s."""
    r = fm().process(rgb)
    if not r.multi_face_landmarks: return None
    L = r.multi_face_landmarks[0].landmark; h, w = rgb.shape[:2]
    Q = lambda i: np.array([L[i].x * w, L[i].y * h])          # image pixels
    P = lambda i: np.array([x0, y0]) + Q(i) / s                # frame pixels
    top, chin = P(10), P(152)
    fh = np.linalg.norm(top - chin) + 1e-6
    gap = np.linalg.norm(P(13) - P(14)) / fh
    el = np.linalg.norm(P(159) - P(145)) / (np.linalg.norm(P(33) - P(133)) + 1e-6)
    er = np.linalg.norm(P(386) - P(374)) / (np.linalg.norm(P(362) - P(263)) + 1e-6)
    eye_l, eye_r = (P(33) + P(133)) / 2, (P(362) + P(263)) / 2
    eye_d = np.linalg.norm(eye_r - eye_l) + 1e-6
    yaw = float((P(1)[0] - (eye_l[0] + eye_r[0]) / 2) / eye_d)
    teeth, marea = _teeth(rgb, np.array([Q(i) for i in INNER]), np.array([Q(i) for i in OUTER]))
    if gap < 0.006: teeth = 0.0                      # lips together: the inner outline is lip, not teeth
    c = (top + chin) / 2
    return dict(gap=float(gap), teeth=round(teeth, 3), ear=float(min(el, er)), fh=float(fh), yaw=yaw, cx=float(c[0]), cy=float(c[1]))


def moved(a, b):
    """Face-centre travel between two states, in face heights."""
    return float(np.hypot(a['cx'] - b['cx'], a['cy'] - b['cy']) / max(a['fh'], b['fh'], 1e-6))


_box = None


def state(rgb):
    """Always measured on an upscaled crop around the detected face: FaceMesh on a whole wide frame
    sometimes returns a wide-open mouth for a closed one (small faces, AC#12 green screen)."""
    global _box
    h, w = rgb.shape[:2]
    d = fd().process(rgb)
    if d.detections:
        b = d.detections[0].location_data.relative_bounding_box
        cx, cy, bw, bh = (b.xmin + b.width / 2) * w, (b.ymin + b.height / 2) * h, b.width * w, b.height * h
        _box = (cx, cy, max(bw, bh))
    if _box is None: return _measure(rgb)
    cx, cy, sz = _box; half = int(sz * 1.4)
    x0, y0 = max(0, int(cx - half)), max(0, int(cy - half)); x1, y1 = min(w, int(cx + half)), min(h, int(cy + half))
    crop = np.ascontiguousarray(rgb[y0:y1, x0:x1])
    if crop.size == 0: return _measure(rgb)
    import PIL.Image as I
    sc = 512.0 / crop.shape[1]
    up = np.asarray(I.fromarray(crop).resize((512, int(crop.shape[0] * sc)), I.BICUBIC))
    s = _measure(up, x0, y0, sc)
    return s if s is not None else _measure(rgb)


def hands(rgb, st):
    """Wrist positions from Pose. A visible wrist above the lower chest = hand raised (gesturing, touching the face)."""
    r = pose().process(rgb)
    if not r.pose_landmarks: return dict(hands='unknown')
    L = r.pose_landmarks.landmark; h, w = rgb.shape[:2]
    pt = lambda i: (L[i].x * w, L[i].y * h, L[i].visibility)
    ls, rs, lh, rh = pt(11), pt(12), pt(23), pt(24)
    sh_y = (ls[1] + rs[1]) / 2
    if lh[2] > 0.5 and rh[2] > 0.5: torso = (lh[1] + rh[1]) / 2 - sh_y
    else: torso = (st['fh'] if st else 0.12 * h) * 2.4
    out, raised = {}, False
    for k, i in (('lw', 15), ('rw', 16)):
        x, y, v = pt(i)
        if v < 0.5 or y >= h - 2: continue                    # out of frame / under the desk = resting
        out[k] = (x, y)
        if y < sh_y + 0.55 * torso: raised = True
    out['hands'] = 'raised' if raised else 'rest'
    out['torso'] = float(torso)
    return out


def reset():
    global _box; _box = None
