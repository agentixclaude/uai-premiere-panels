"""Where the talk to camera really starts and ends, from a transcript of the first and last 30 s.

The audio level finds every sound; the words tell which of them belong to the take. Before the first line people
say "ready?", "rolling", "okay" or count in; after the last line they ask "was that good?", say "cut", laugh or talk
to the crew. Those bits sit apart from the delivery (a gap of >= 1.2 s) and are short, or are known cue words.

Uses faster-whisper (CPU, int8) when it is installed; without it the trim stays audio + face only.
script_bounds(path, dur) -> {start, end, first_words, last_words, dropped_head, dropped_tail} | None"""
import os, re, subprocess, numpy as np

MODEL = os.environ.get('LUMACUT_WHISPER', 'base.en')
EDGE = 20.0
GAP = 1.2
HEAD_CUES = re.compile(r"\b(ready|rolling|roll|action|speed|mark|go ahead|whenever|okay|ok|alright|all right|one two three|three two one|3 2 1|start)\b", re.I)
TAIL_CUES = re.compile(r"\b(cut|was that (good|ok|okay|fine|alright)|how was (that|it)|is that (good|ok|okay)|did (that|it) work|one more|again|okay|ok|alright|all right|done|that's it)\b", re.I)
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
            out.append(dict(w=w.word.strip(), s=t0 + w.start, e=t0 + w.end))
    return out


def _groups(words):
    """Split words into phrases at gaps >= GAP."""
    g = []
    for w in words:
        if g and w['s'] - g[-1][-1]['e'] < GAP: g[-1].append(w)
        else: g.append([w])
    return g


def _text(g): return ' '.join(w['w'] for w in g)


def script_bounds(p, dur):
    if not available(): return None
    head = _words(p, 0, min(dur, EDGE))
    tail = _words(p, max(0, dur - EDGE), dur) if dur > EDGE else head
    if not head or not tail: return None
    dropped_head, dropped_tail = [], []
    head_prev = tail_next = None
    # slate words said in one breath with the take: "... five, four, three, two, action. <first line>" / "<last line> ... cut"
    norm = lambda w: re.sub(r'[^a-z]', '', w['w'].lower())
    for i in range(len(head) - 1, -1, -1):
        if norm(head[i]) in ('action', 'rolling') and i + 1 < len(head):
            dropped_head.append(' '.join(w['w'] for w in head[:i + 1])); head_prev = head[i]['e']; head = head[i + 1:]; break
    for i in range(len(tail)):
        if norm(tail[i]) == 'cut' and i > 0:
            dropped_tail.append(' '.join(w['w'] for w in tail[i:])); tail_next = tail[i]['s']; tail = tail[:i]; break
    # count-in said in one breath with the take ("three, two, one, <first line>"): descending numbers, at least two
    NUM = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10}
    k = 0
    while k < len(head) - 1 and norm(head[k]) in NUM and (k == 0 or NUM[norm(head[k])] < NUM[norm(head[k - 1])]): k += 1
    if k >= 2:
        dropped_head.append(' '.join(w['w'] for w in head[:k])); head_prev = head[k - 1]['e']; head = head[k:]
    hg, tg = _groups(head), _groups(tail)
    # leading / trailing phrases that are cues or a word or two, set apart by a gap
    while len(hg) > 1 and (HEAD_CUES.search(_text(hg[0])) and len(hg[0]) <= 6 or len(hg[0]) <= 2):
        g = hg.pop(0); dropped_head.append(_text(g)); head_prev = max(head_prev or 0, g[-1]['e'])
    while len(tg) > 1 and (TAIL_CUES.search(_text(tg[-1])) and len(tg[-1]) <= 8 or len(tg[-1]) <= 2):
        g = tg.pop(); dropped_tail.insert(0, _text(g)); tail_next = min(tail_next or 1e9, g[0]['s'])
    first, last = hg[0], tg[-1]
    return dict(start=first[0]['s'], end=last[-1]['e'],
                first_words=_text(first)[:80], last_words=_text(last)[-80:],
                dropped_head=dropped_head, dropped_tail=dropped_tail, head_prev=head_prev, tail_next=tail_next)
