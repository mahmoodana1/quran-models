# the test ayat for the lab: Uthmani words and the Muaalem phonetic script
# (Hafs, quran-transcript) of each word, as [start, end) in the aya's script
import json, sys
import quran_transcript as qt
AYAT = [(1, 2), (1, 5), (1, 6), (1, 7), (112, 1), (112, 2), (112, 3), (112, 4), (103, 1), (103, 2), (103, 3),
        (67, 1), (67, 2), (67, 3), (55, 1), (55, 2), (55, 3), (55, 4), (2, 255)]
m = qt.MoshafAttributes(rewaya='hafs', madd_monfasel_len=4, madd_mottasel_len=4, madd_mottasel_waqf=4, madd_aared_len=4)
out = []
for s, a in AYAT:
    f = qt.Aya(s, a).get()
    t = f.uthmani
    o = qt.quran_phonetizer(t, m, remove_spaces=True, sura_idx=s)
    assert len(o.mappings) == len(t), (s, a)
    spans, w, lo, hi = [], 0, None, None
    for i, ch in enumerate(t + ' '):
        if ch == ' ':
            spans.append([lo, hi]); w += 1; lo = hi = None
            continue
        p = o.mappings[i]
        if p.deleted or p.pos[0] == p.pos[1]: continue
        lo = p.pos[0] if lo is None else min(lo, p.pos[0]); hi = p.pos[1] if hi is None else max(hi, p.pos[1])
    # words sharing sounds with the next (idgham) keep what the mapping gives; empty ones borrow their neighbour's edge
    prev = 0
    for sp in spans:
        if sp[0] is None: sp[0] = sp[1] = prev
        prev = sp[1]
    words = f.uthmani_words
    assert len(words) == len(spans), (s, a, len(words), len(spans))
    out.append({'s': s, 'a': a, 'name': f.sura_name, 'words': words, 'ph': o.phonemes, 'spans': spans})
    print(s, a, o.phonemes[:60], [o.phonemes[x:y] for x, y in spans][:5])
json.dump(out, open(sys.argv[1], 'w'), ensure_ascii=False, separators=(',', ':'))
