"""Where the real talk to camera starts and ends (engine v3, 2026-11-26).

The audio finds every sound; the words decide which of them belong to the take.
Before the first line people count in ("3, 2, 1", "5 4 3 2 in action"), take instructions ("again, a little
slower this time", "ready?", "start"), apologise ("hold on, I goofed up") or mumble. After the last line they say
"I'm done", "close my mouth", "sign off", "okay so I'm about ready to finish", "was that good?", "cut" or count out.

IN anchor  = first word of the delivery. Preferred openers: Hi / Hey / Hello / My name (strong), I'm / I (weak).
OUT anchor = last word before the closing remarks.

Uses faster-whisper (CPU, int8). bounds(path, dur) -> dict | None"""
import os, re, subprocess, numpy as np

MODEL = os.environ.get('LUMACUT_WHISPER', 'tiny.en')
EDGE = 25.0
CLAUSE_GAP = 0.6           # a pause this long ends a clause
RUN_GAP = 1.2              # a pause this long sets a mumble apart from the delivery
NUMS = {'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'}
FILLER = {'and', 'so', 'okay', 'ok', 'alright', 'all', 'right', 'um', 'uh', 'that', 'yeah', 'well', 'but', 'now',
          "i'm", 'im', 'going', 'to', 'gonna', 'let', 'me'}   # stripped from the end of what is kept before a closing remark
HEAD_META = re.compile(r"\b(action|rolling|roll it|ready|speed|start|starting|again|slower|faster|this time|hold on|wait|"
                       r"sorry|goofed|messed up|my bad|take (two|three|four|\d)|one more|go ahead|go|yeah|yep|okay|ok|"
                       r"alright|all right|in|countdown|count)\b")
STRONG = re.compile(r"^(hi|hey|hello|good (morning|afternoon|evening)|my name)\b")
WEAK = re.compile(r"^(i'm|i am|i|im)\b")
TAIL_META = [re.compile(x) for x in (
    r"\b(and )?(i'm|i am|im) (done|finished)\b", r"\bclos(e|ing) (my mouth|up)\b", r"\b(put )?(my )?hands? (back|down)\b",
    r"\bsign(ing)? off\b", r"\b(i'm |i am )?(about |almost )?ready to (finish|stop|end)\b", r"\bfinish(ing)? up\b",
    r"\bwhat am i doing\b", r"\bdo i need to\b", r"\b(i'm )?(going to |gonna )?go back\b", r"\b(i'm )?(going to |gonna )?keep going\b",
    r"\b(was|is) (that|it) (good|ok|okay|fine|alright|all right)\b", r"\bhow (was|is) (that|it)\b", r"\bone more\b", r"\bcut\b",
    r"\b(one|1) (two|2)\b", r"\blet me (smile|finish|start|do|stop)\b", r"\bthat's a wrap\b")]
CREW = re.compile(r"^(so |and )?(perfect|great|good|nice|awesome|beautiful|excellent|got it|that's good|that was good|okay|ok|"
                  r"alright|all right|so|cool|yes|yeah|thank you okay|so all right|so alright)( \w+)?$")   # short last words, often the crew
SHORT_TAIL_META = re.compile(r"\b(okay|ok|alright|all right),? (so|well)\b")   # only in a short clause; long ones carry real talk
_model = None


def available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _load():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL, device='cpu', compute_type='int8')
    return _model


def _audio(p, t0, t1):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{max(0, t0):.3f}', '-i', p, '-t', f'{t1 - t0:.3f}',
                                   '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'])
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def _words(p, t0, t1):
    segs, _ = _load().transcribe(_audio(p, t0, t1), language='en', word_timestamps=True, vad_filter=True, beam_size=1)
    out = []
    for s in segs:
        for w in (s.words or []):
            t = w.word.strip()
            if t: out.append(dict(w=t, s=t0 + w.start, e=t0 + w.end))
    return out


def norm(w): return re.sub(r"[^a-z0-9']", '', w['w'].lower().replace('’', "'"))


def clauses(words):
    """Split at punctuation or a pause >= CLAUSE_GAP."""
    out = []
    for w in words:
        if out and not re.search(r'[.?!,;:]$', out[-1][-1]['w']) and w['s'] - out[-1][-1]['e'] < CLAUSE_GAP: out[-1].append(w)
        else: out.append([w])
    return out


def text(c): return ' '.join(norm(w) for w in c).strip()


def raw(c): return ' '.join(w['w'] for w in c)


def numbers_only(c): return all(norm(w) in NUMS for w in c)


def meta_head(c):
    t = text(c)
    if numbers_only(c): return True
    return len(c) <= 8 and bool(HEAD_META.search(t)) and not STRONG.search(t)


HARD = re.compile(r"\b(action|rolling|ready|speed|go ahead|and go|let's go|here we go|start now|you're going|we're going)\b")


def count_in(c):
    """A clause that holds a count (two or more numbers, or a number with a cue word)."""
    n = sum(1 for w in c if norm(w) in NUMS)
    return n >= 2 or (n >= 1 and len(c) <= 4)


def head_start(words):
    """Index of the first word of the delivery, and what was dropped before it."""
    cl = clauses(words)
    if not cl: return None
    # everything up to the LAST slate / count-in / "ready?" in the first 15 s is not the take
    cut = 0
    for i, c in enumerate(cl):
        if c[0]['s'] > 15: break
        if len(c) <= 8 and (HARD.search(text(c)) or count_in(c)): cut = i + 1
    if 0 < cut < len(cl):
        off = sum(len(c) for c in cl[:cut])
        r = head_start(words[off:]) if any(not meta_head(c) for c in cl[cut:]) else 0
        return off + (r or 0)
    starts = [0]
    for c in cl[:-1]: starts.append(starts[-1] + len(c))

    def ok_before(i):
        before = cl[:i]
        if not before: return True
        if all(meta_head(b) for b in before): return True
        gap = cl[i][0]['s'] - before[-1][-1]['e']
        return gap >= RUN_GAP and sum(len(b) for b in before) <= 15

    for rx in (STRONG, WEAK):
        for i, c in enumerate(cl):
            if c[0]['s'] > EDGE - 3: break
            if rx.search(text(c)) and not meta_head(c) and ok_before(i): return starts[i]
    for i, c in enumerate(cl):
        if not meta_head(c): return starts[i]
    return 0


def tail_end(words):
    """Index (exclusive) after the last word of the delivery."""
    cl = clauses(words)
    if not cl: return None
    n = len(words)
    for c in reversed(cl):
        t = text(c); toks = t.split()
        if numbers_only(c) or (len(c) <= 3 and CREW.search(t)):
            n -= len(c); continue
        k = None
        for rx in TAIL_META + ([SHORT_TAIL_META] if len(c) <= 8 else []):
            m = rx.search(t)
            if m:
                wi = len(t[:m.start()].split())
                k = wi if k is None else min(k, wi)
        if k is None: return n
        keep = c[:k]
        while keep and norm(keep[-1]) in FILLER: keep = keep[:-1]
        # only a few words kept and no pause before the closing remark: they belong to it, the whole clause goes
        if keep and len(keep) <= 4 and c[len(keep)]['s'] - keep[-1]['e'] < 0.25: keep = []
        if keep: return n - len(c) + len(keep)
        n -= len(c)
    return n


def bounds(p, dur):
    if not available(): return None
    head = _words(p, 0, min(dur, EDGE))
    tail = _words(p, max(0, dur - EDGE), dur) if dur > EDGE else head
    if not head or not tail: return None
    i = head_start(head); j = tail_end(tail)
    if i is None or j is None or i >= len(head) or j <= 0: return None
    first, last = head[i], tail[j - 1]
    return dict(start=first['s'], end=last['e'],
                first_words=raw(head[i:i + 8]), last_words=raw(tail[max(0, j - 8):j]),
                dropped_head=raw(head[:i]), dropped_tail=raw(tail[j:]),
                head_prev=head[i - 1]['e'] if i > 0 else None, tail_next=tail[j]['s'] if j < len(tail) else None,
                full_end=tail[-1]['e'])


# kept for older callers
def script_bounds(p, dur):
    b = bounds(p, dur)
    if b: b = dict(b, dropped_head=[b['dropped_head']] if b['dropped_head'] else [], dropped_tail=[b['dropped_tail']] if b['dropped_tail'] else [])
    return b
