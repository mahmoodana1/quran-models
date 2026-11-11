'use strict';

// Matches what the model heard (Quran phonetic script) against what the aya
// should sound like, and says for each word of the aya whether it was said
// right, said with a mistake, is being heard now, or is still to come.
//
// It is a weighted alignment (edit distance) over sound units, so a single
// aya costs well under a millisecond. Differences the model makes even on
// perfect recitation are cheap and never reported:
//   - sounds it confuses (م/ن/ں, ت/ط, د/ض, س/ص/ث, ذ/ز/ظ, ق/ك, ء/ع, ه/ح, …)
//   - madd length (ا ۦ ۥ said 2, 4 or 6 counts), ghunna length (ں)
//   - small marks (qalqala ڇ, sakt ۜ, …)
// Going back to say words again (to repeat, or to correct oneself) is never a
// mistake: what counts is the last time each word was said.
// A pause between two words (to breathe, or at a stop sign) changes how the
// words around it sound, and is never a mistake: the last haraka dropped, a
// tanween said as a long ā or left out, a hamza before the next word's ٱلْ.
// A wrong haraka is a mistake. Letters the model mishears (even from the best
// reciters: غ as ر, خ as ق, …, and more on a phone) are forgiven until the word
// is clearly another: fewer than half its letters heard, or four off.
const Match = (() => {
  const HARAKA = new Set(['َ', 'ُ', 'ِ']);
  const MADD = new Set(['ا', 'ۦ', 'ۥ', 'ں']);           // runs of these are one unit
  const MARK = new Set(['ڇ', 'ۜ', 'ؙ', '۪', 'ٲ', 'ـ', '۾']);
  const GROUPS = ['منں۾', 'تط', 'دض', 'سصث', 'ذزظ', 'قك', 'ءع', 'هح', 'يۦ', 'وۥ', 'اء'];
  // and single pairs (letters the model hears as each other, across reciters)
  const PAIRS = ['تث', 'بم', 'خق', 'غر'];
  const alike = new Set();
  for (const g of GROUPS.concat(PAIRS)) for (const a of g) for (const b of g) if (a !== b) alike.add(a + b);

  const LETTER = 0.6; // one letter wrong; a word is a mistake from a cost of 1
  const kind = c => HARAKA.has(c) ? 'h' : MARK.has(c) ? 'm' : MADD.has(c) ? 'd' : 'l';

  // the script as unit ids; a run of one madd char is one unit
  const ALPHA = new Map(), CH = [];
  const id = c => { let i = ALPHA.get(c); if (i == null) { i = CH.length; ALPHA.set(c, i); CH.push(c); } return i; };
  function units(s) {
    const u = [];
    for (const c of s) {
      const i = id(c);
      if (MADD.has(c) && u.length && u[u.length - 1] === i) continue;
      u.push(i);
    }
    return u;
  }

  // costs, precomputed per pair of sounds: [cost, mistake type]
  const TYPES = [null, 'haraka', 'letter', 'missing', 'extra', 'madd', 'ghunna', 'heavy', 'near', 'maddlong', 'maddnone']; // (and 'order': see words())
  let K = 0, built = 0, SUBC, SUBT, DELC, DELT, INSC, INST, LET, ISMADD, ISHAR;
  // (re)build the tables when sounds were added
  function grow() {
    const n = CH.length;
    if (n === built) return;
    built = n; K = Math.max(64, n);
    SUBC = new Float32Array(K * K); SUBT = new Uint8Array(K * K);
    DELC = new Float32Array(K); DELT = new Uint8Array(K); INSC = new Float32Array(K); INST = new Uint8Array(K); LET = new Uint8Array(K); ISMADD = new Uint8Array(K); ISHAR = new Uint8Array(K);
    for (let x = 0; x < n; x++) {
      const a = [CH[x], kind(CH[x])];
      [DELC[x], DELT[x]] = cost1(del(a)); [INSC[x], INST[x]] = cost1(ins(a)); LET[x] = a[1] === 'l' ? 1 : 0;
      ISMADD[x] = a[1] === 'd' && a[0] !== 'ں' ? 1 : 0; ISHAR[x] = a[1] === 'h' ? 1 : 0;
      for (let y = 0; y < n; y++) [SUBC[x * K + y], SUBT[x * K + y]] = cost1(sub(a, [CH[y], kind(CH[y])]));
    }
  }
  const cost1 = ([c, t]) => [c, TYPES.indexOf(t)];
  [...'ءبتثجحخدذرزسشصضطظعغفقكلمنهويا' + 'ۦۥَُِ۪ـٲڇں۾ؙۜ'].forEach(id);
  const NUN = id('ن'), HAMZA = id('ء'), LAM = id('ل'), RA = id('ر'), MIM = id('م'), GH = id('ں'), YA = id('ي'), WAW = id('و');
  // a long ī or ū heard as ay or aw (طِين as طَين): how the model hears some voices, never a reader's
  // mistake. The vowel before the madd, heard as fatha with the madd as a consonant: not marked
  const FATHA = id('َ'), DIPH = new Map([[id('ِ'), [id('ۦ'), YA]], [id('ُ'), [id('ۥ'), WAW]]]);
  // letters the model tells apart (heard as the other with confidence, by correct reciters: under 0.1%
  // of the time, the study), each a mistake of its own with opt.letters: a heavy letter said light
  // or the other way (heavy), and letters near in sound (near). Not ت/ث nor ث/س (the model confuses
  // them, and readers' ث differ), nor ن/م inside a ghunna or at a stop, where the two sound alike.
  // Only when the model heard the other letter all but surely (LETTER_SURE), or fairly surely
  // (LETTER_OFTEN) when this reader says it so twice or more in the session: the caller tells it
  // opt.letters.often(pair, times = 2), and hears of each one so first (opt.letters.heard(pair, unit))
  const HEAVY = ['سص', 'تط', 'دض', 'ذظ', 'زظ', 'قك'], CLOSE = ['من', 'هح', 'ءع', 'ذز'];
  const PAIR = new Map(); // 'ab' -> 7 heavy | 8 near
  for (const [g, t] of [[HEAVY, 7], [CLOSE, 8]]) for (const q of g) { PAIR.set(q, t); PAIR.set(q[1] + q[0], t); }
  const LETTER_SURE = 0.99, TA_SURE = 0.99, LETTER_OFTEN = 0.8;
  // letters near in sound (ء/ع, ه/ح, …) said quickly blur into each other, for the model as for the ear:
  // never marked on one hearing, only from the NEAR_OFTEN-th time in the session, and not at all
  // where the reading around it goes faster than NEAR_FAST frames (40 ms) a sound
  const NEAR_OFTEN = 3, NEAR_FAST = 4;
  const FAST_ALIKE = new Set(['دذ', 'ذد', 'تد', 'دت', 'ءا', 'اء', 'ءي', 'يء', 'ءو', 'وء']);
  const TA = new Set(['تط', 'طت']);

  function sub(a, b) {
    if (a[0] === b[0]) return [0, null];
    if (a[1] === 'm' || b[1] === 'm') return [0.15, null];
    if (alike.has(a[0] + b[0])) return [0.2, null];
    if (a[1] === 'h' && b[1] === 'h') return [1, 'haraka'];
    if (a[1] === 'd' && b[1] === 'd') return [0.4, null];
    return a[1] === 'h' ? [1, 'haraka'] : [LETTER, 'letter'];
  }
  // expected unit not heard
  function del(a) {
    if (a[1] === 'm') return [0.1, null];
    if (a[1] === 'd') return [0.5, null];     // madd said very short: tajweed, not a word mistake
    if (a[1] === 'h') return [0.8, 'haraka'];
    if (a[0] === 'ه') return [0.6, null];     // a soft ha the model often drops
    return [LETTER, 'missing'];
  }
  // heard unit not expected
  function ins(b) {
    if (b[1] === 'm') return [0.1, null];
    if (b[1] === 'd') return [0.4, null];
    if (b[1] === 'h') return [0.7, null];
    return [LETTER, 'extra'];
  }
  const SHADDA = 0.3; // a doubled letter said single, or a single one said doubled: not reported
  const PAUSE = 0.25; // what a pause between words changes: not reported
  const LEAD = 0.3;   // each sound heard before the aya begins, with opt.freeLead (less than a wrong letter)
  const UNSURE = 0.75; // below this confidence, a heard sound is not trusted to show a mistake (0.6 marked twice as many words in a noisy room, for the same mistakes caught)
  const SHORT_SURE = 0.9; // a short word's haraka marked wrong only when heard this surely
  const FAST_HAR_SURE = 0.97; // and any word's, in a fast reading (opt.fast)
  const ALT_MIN = 0.1; // a runner-up sound given at least this chance
  const WSKIP = 1.8; // a whole word left out costs at most this, however long (a long word skipped
  // otherwise costs so much that any fuzzy reading of what was heard explains it better; the
  // study: 96% of skipped words caught, from 92.5, for one more word wrongly marked in 5532)
  const REPEAT = 1.2, REPEAT_WORDS = 12; // going back to say words again: its cost (no mistake), and how far back

  // expected: { ph, spans: [[start, end) per word] } in script characters,
// and which words start with hamzat al-wasl: wasl (indices) or words (text)
  // heard: the model's text so far; finalLen: how much of it is final;
  // done: the reciter stopped, so the whole aya must be accounted for
  // expected.ends (optional): the words that end an aya (where ayas are read one after another; else the last)
  // opt.tajweed: true, or { madd, ghunna, munfasil }: those tajweed rules checked (see tajweed())
  // opt.freeLead: what was heard before the aya (a basmala, an isti'adha) costs nothing
  // opt.fast: a fast reading (hadr), which the model hears far less well (sounds swallowed, others
  // heard in their place): only what shows through that is marked: a word left out with nothing heard
  // in its place, or another said, with under a third of its letters heard; never a haraka (see quick())
  // opt.freeStart: the reading may begin at any word (those before it: state 'pre')
  // opt.conf: how sure the model was of each heard character (0..1); a mismatch
  // on a sound it was unsure of is taken for a mishearing, never a mistake
  // opt.at: per heard character, the frame it starts on (a madd's time: see tajweed())
  // opt.alts: per heard character, the other sounds the model gave a fair chance
  // (a string, or { sound: chance }); when the expected sound is one, it counts as heard
  // expected.refs (optional): per word, how real reciters reading it right were
  // heard (where that differs from how it should sound); a word heard like one
  // of them is not a mistake
  // returns per word { state: 'ok'|'err'|'hear'|'todo', type, heard, at }
  function core(expected, heard, finalLen, done, opt) {
    if (!expected._u) prepare(expected);
    const E = expected._u, edge = expected._edge, H = units(heard);
    // each heard unit's confidence (a run of one madd char: its surest)
    let Hc = null;
    if (opt.conf) {
      Hc = new Float32Array(H.length);
      let u = -1, prev = null, k = 0;
      for (const c of heard) {
        if (!(MADD.has(c) && c === prev)) u++;
        Hc[u] = Math.max(Hc[u], opt.conf[k] ?? 1);
        prev = c; k++;
      }
    }
    const unsure = i => Hc !== null && Hc[i] < UNSURE;
    // each heard unit's runner-ups, as sound ids
    let Ha = null;
    if (opt.alts) {
      Ha = new Array(H.length);
      let u = -1, prev = null, k = 0;
      for (const c of heard) {
        if (!(MADD.has(c) && c === prev)) u++;
        const a = opt.alts[k] || '';
        for (const x of typeof a === 'string' ? a : Object.keys(a).filter(y => a[y] >= ALT_MIN)) (Ha[u] ||= new Set()).add(id(x));
        prev = c; k++;
      }
      grow();
    }
    const runnerUp = (i, e) => Ha !== null && !!Ha[i]?.has(e);
    // each heard unit's length (a madd's, or ں's, run)
    const Hlen = new Uint8Array(H.length);
    { let u = -1, prev = null; for (const c of heard) { if (!(MADD.has(c) && c === prev)) u++; Hlen[u] = Math.min(255, Hlen[u] + 1); prev = c; } }
    // (opt.at: the frame each heard character starts on) each heard unit's length in time, to the
    // next one's start (-1: the last, or not known)
    let Hdur = null;
    if (opt.at) {
      Hdur = new Int16Array(H.length).fill(-1);
      let u = -1, prev = null, c = 0;
      const st = [];
      for (const ch of heard) { if (!(MADD.has(ch) && ch === prev)) st[++u] = opt.at[c]; prev = ch; c++; }
      for (let i = 0; i + 1 < st.length; i++) if (st[i] != null && st[i + 1] != null) Hdur[i] = Math.min(32767, st[i + 1] - st[i]);
    }
    // how fast the reading goes around heard unit i: the frames a sound takes, over the four
    // either side (madds and pauses left out); not known: not fast
    const fast = i => {
      if (!Hdur) return false;
      let t = 0, k = 0;
      for (let x = Math.max(0, i - 4); x <= Math.min(H.length - 1, i + 4); x++) if (Hdur[x] > 0 && Hdur[x] <= 12 && !ISMADD[H[x]]) { t += Hdur[x]; k++; }
      return k >= 4 && t / k < NEAR_FAST;
    };
    // (fast: how many of a word's letters were heard anywhere in what was heard for it, as themselves or
    // a letter near them: hadr runs them together, and the model hears them out of place)
    const bag = (a, b) => {
      let p0 = -1, p1 = -1, n = 0;
      for (let k = a; k < Math.min(b, end); k++) if (pos[k] >= 0) { if (p0 < 0) p0 = pos[k]; p1 = pos[k] + 1; }
      if (p0 < 0) return 0;
      for (let k = a; k < b; k++) if (LET[E[k]]) for (let i = p0; i < p1; i++) if (H[i] === E[k] || alike.has(CH[E[k]] + CH[H[i]]) || PAIR.has(CH[E[k]] + CH[H[i]]) || FAST_ALIKE.has(CH[E[k]] + CH[H[i]])) { n++; break; }
      return n;
    };
    const hFinal = units(heard.slice(0, finalLen)).length;
    grow();
    const n = H.length, m = E.length, W = m + 1;
    const cost = new Float32Array((n + 1) * W), back = new Uint8Array((n + 1) * W);
    // deleting E[j], with the shadda and pause allowances; dbad: whether that is a mistake
    // wh: the haraka of a hamzat al-wasl at the aya's start (ءَ); said joined to the aya
    // before, both go: the haraka alone left out, or said differently, is still a mistake
    const dcost = new Float32Array(m), dbad = new Uint8Array(m), wh = new Uint8Array(m);
    for (let j = 0; j < m; j++) {
      wh[j] = j && edge[j - 1] === 2 && E[j - 1] === HAMZA && ISHAR[E[j]] ? 1 : 0;
      if (LET[E[j]] && j && E[j - 1] === E[j]) dcost[j] = SHADDA;
      else if (edge[j] === 1 && (ISHAR[E[j]] || E[j] === NUN)) dcost[j] = PAUSE;
      else if (edge[j] === 2 && E[j] === HAMZA) dcost[j] = PAUSE;
      else { dcost[j] = DELC[E[j]]; dbad[j] = DELT[E[j]] ? 1 : 0; }
    }
    // hearing h where E[j] was expected; a tanween's ن said as a long ā at a pause is fine
    const subc = (j, h) => edge[j] === 1 && E[j] === NUN && ISMADD[h] ? PAUSE : SUBC[E[j] * K + h];
    // hearing h before E[j]: a doubled letter, or a hamza starting a word after a pause, is fine
    // but a haraka heard where a word's last haraka was expected is a wrong haraka, not a pause
    // (on either side of it): returns which expected unit it belongs to, or -1
    const endHar = (j, h) => !ISHAR[h] ? -1 : j > 0 && edge[j - 1] === 1 && ISHAR[E[j - 1]] ? j - 1 : j < m && edge[j] === 1 && ISHAR[E[j]] ? j : -1;
    // (and the haraka after that hamza: ءَ or ءِ); before an aya opening with hamzat al-wasl
    // joined to the one before, that aya's tanween and the haraka joining them (أَحَدٌ ٱللَّهُ: دُنِللَاهُ)
    const wasl = (i, j, h) => j < m && edge[j] === 2 && (h === HAMZA || (ISHAR[h] && i > 1 && H[i - 2] === HAMZA) || (E[j] === HAMZA && (h === NUN || ISHAR[h])));
    const WASL_H = 0.4;
    const delc = (r, j) => wh[j - 1] && back[r + j - 1] === 2 ? WASL_H : dcost[j - 1];
    const insc = (i, j, h, ic) => LET[h] && E[j - 1] === h ? SHADDA : wasl(i, j, h) ? PAUSE : endHar(j, h) >= 0 ? 1 : ic;
    for (let j = 1; j <= m; j++) { cost[j] = cost[j - 1] + delc(0, j); back[j] = 2; }
    // a word left out whole: from its start to its end at WSKIP (back 5), then on as usual
    const skipWords = r => {
      let moved = false;
      for (const [a, b] of expected._w) if (b > a && cost[r + a] + WSKIP < cost[r + b] - 1e-6) {
        cost[r + b] = cost[r + a] + WSKIP; back[r + b] = 5; moved = true;
        for (let j = b + 1; j <= m && cost[r + j - 1] + delc(r, j) < cost[r + j] - 1e-6; j++) { cost[r + j] = cost[r + j - 1] + delc(r, j); back[r + j] = 2; }
      }
      return moved;
    };
    skipWords(0);
    const wordEnd = new Int32Array(m + 1).fill(-1);
    for (const [a, b] of expected._w) if (b > a) wordEnd[b] = a;
    if (opt.freeStart) for (const [a] of expected._w) if (a > 0 && a < m) { cost[a] = 0; back[a] = 0; }
    // both: the reading may begin at any word after any lead heard (a false start, said and left,
    // before the aya read: the words before it not all counted left out) (back 6)
    const leadStart = opt.freeStart && opt.freeLead ? new Uint8Array(m + 1) : null;
    if (leadStart) for (const [a] of expected._w) if (a > 0 && a < m) leadStart[a] = 1;
    // words (in units), and for each row and word, where a going-back to that
    // word's start came from (-1: none); jumps only ever land on a word's start
    const ws = expected._w.filter(([a, b]) => b > a), nw = ws.length, jump = new Int32Array((n + 1) * Math.max(1, nw)).fill(-1);
    const wordAt = new Int32Array(m + 1).fill(-1);
    ws.forEach(([a], v) => { if (wordAt[a] < 0) wordAt[a] = v; });
    for (let i = 1; i <= n; i++) {
      const r = i * W, p = r - W, h = H[i - 1];
      const ic = LET[h] && i > 1 && H[i - 2] === h ? SHADDA : unsure(i - 1) ? Math.min(INSC[h], SHADDA) : INSC[h];
      cost[r] = cost[p] + (opt.freeLead ? LEAD : ic); back[r] = 3;
      for (let j = 1; j <= m; j++) {
        let c = cost[p + j - 1] + (runnerUp(i - 1, E[j - 1]) ? 0.05 : unsure(i - 1) ? Math.min(subc(j - 1, h), 0.2) : subc(j - 1, h)), b = 1;
        const d = cost[r + j - 1] + delc(r, j);
        if (d < c) { c = d; b = 2; }
        const s = cost[p + j] + insc(i, j, h, ic);
        if (s < c) { c = s; b = 3; }
        if (leadStart?.[j] && cost[r] < c) { c = cost[r]; b = 6; }
        cost[r + j] = c; back[r + j] = b;
      }
      // going back: after a word, the reader may start again from up to REPEAT_WORDS
      // words before (to repeat, or to correct themselves); then forward as usual
      if (nw > 1) {
        let moved = false;
        for (let v = 0; v < nw; v++) {
          // the cheapest word end within REPEAT_WORDS after this word's start
          const to = ws[v][0];
          let best = Infinity, from = -1;
          for (let we = v; we < Math.min(nw, v + REPEAT_WORDS); we++) { const f = ws[we][1]; if (f > to && cost[r + f] < best) { best = cost[r + f]; from = f; } }
          if (from >= 0 && best + REPEAT < cost[r + to] - 1e-6) { cost[r + to] = best + REPEAT; back[r + to] = 4; jump[i * nw + v] = from; moved = true; }
        }
        if (moved) for (let j = 1; j <= m; j++) if (cost[r + j - 1] + delc(r, j) < cost[r + j] - 1e-6) { cost[r + j] = cost[r + j - 1] + delc(r, j); back[r + j] = 2; }
      }
      skipWords(r);
    }
    let end = m;
    if (!done) { end = 0; for (let j = 1, r = n * W; j <= m; j++) if (cost[r + j] < cost[r + end] - 1e-6) end = j; }
    // walk back: what happened to each expected unit
    const bad = new Float32Array(m + 1), type = new Uint8Array(m + 1), got = new Array(m).fill(''), fin = new Uint8Array(m), pos = new Int32Array(m).fill(-1);
    const al = new Uint8Array(m); // the unit was lined up with a heard one (pos: which)
    const hit = new Uint8Array(m); // the unit was heard (as itself, or as a sound it is confused with)
    const seen = new Uint8Array(m + 1); // judged already: from a later attempt (said again), which is the one that counts
    let i = n, j = end, steps = 0, start = 0, back0 = m; // back0: the earliest word gone back to
    while (i > 0 || j > 0) {
      if (i === 0 && opt.freeStart && back[j] === 0) { start = j; break; }
      if (++steps > (n + m) * 3 + 64) break; // can't happen; never hang the page if it did
      const b = back[i * W + j];
      if (b === 6) { start = j; j = 0; continue; } // (begun here, after the lead)
      if (b === 4) { const f = jump[i * nw + wordAt[j]]; if (f < 0 || f <= j) break; back0 = Math.min(back0, j); j = f; continue; }
      if (b === 5) { // the word ending here left out whole
        const a = wordEnd[j];
        if (a < 0) break;
        for (let k = j - 1; k >= a; k--) if (!seen[k]) { seen[k] = 1; bad[k] += DELC[E[k]]; type[k] ||= DELT[E[k]] || 2; fin[k] = i <= hFinal; pos[k] = i; }
        j = a; continue;
      }
      if ((b === 1 || b === 2) && seen[j - 1]) { if (b === 1) i--; j--; continue; }
      if (b === 1 || b === 2) seen[j - 1] = 1;
      if (b === 1) {
        const x = E[j - 1] * K + H[i - 1];
        const dp = DIPH.get(E[j - 1]);
        const fine = unsure(i - 1) || runnerUp(i - 1, E[j - 1]) || (dp && H[i - 1] === FATHA && j < m && i < n && E[j] === dp[0] && H[i] === dp[1]);
        if (SUBT[x] && subc(j - 1, H[i - 1]) === SUBC[x] && !fine) { bad[j - 1] += SUBC[x]; type[j - 1] ||= SUBT[x]; }
        else if (opt.letters && !fine && (!Hc || Hc[i - 1] >= LETTER_OFTEN)) {
          const pk = CH[E[j - 1]] + CH[H[i - 1]], pt = PAIR.get(pk), e0 = E[j - 1], c = Hc ? Hc[i - 1] : 1;
          const nasal = (e0 === NUN || e0 === MIM) && (edge[j - 1] === 1 || (j > 1 && (NASAL.has(E[j - 2]))) || (j < m && NASAL.has(E[j])) || (i > 1 && H[i - 2] === GH) || (i < n && (H[i] === GH || NASAL.has(H[i]))));
          if (pt && (pt === 7 ? opt.letters.heavy : opt.letters.near) && !nasal) {
            if (pt === 7) {
              opt.letters.heard?.(pk, j - 1);
              if (c >= (TA.has(pk) ? TA_SURE : LETTER_SURE) || opt.letters.often?.(pk)) { bad[j - 1] += 1; type[j - 1] ||= pt; }
            } else if (!fast(i - 1)) {
              opt.letters.heard?.(pk, j - 1);
              if (opt.letters.often?.(pk, NEAR_OFTEN)) { bad[j - 1] += 1; type[j - 1] ||= pt; }
            }
          }
        }
        // heard as itself, or as a sound it is confused with; a sound the model was unsure of
        // excuses a mismatch, but doesn't count as the unit heard (a long madd held into the
        // next word, heard as unclear sounds, is not that word said)
        hit[j - 1] = subc(j - 1, H[i - 1]) <= PAUSE || runnerUp(i - 1, E[j - 1]) ? 1 : 0;
        if (opt.trace) opt.trace.push([CH[E[j - 1]], CH[H[i - 1]], Hc ? Hc[i - 1] : 1, Ha?.[i - 1] ? [...Ha[i - 1]].map(x => CH[x]).join('') : '', j - 1, i - 1, Hlen[i - 1]]);
        got[j - 1] = CH[H[i - 1]]; fin[j - 1] = i <= hFinal; pos[j - 1] = i - 1; al[j - 1] = 1; i--; j--;
      } else if (b === 2) {
        if (dbad[j - 1] && !(wh[j - 1] && back[i * W + j - 1] === 2)) { bad[j - 1] += DELC[E[j - 1]]; type[j - 1] ||= DELT[E[j - 1]]; }
        fin[j - 1] = i <= hFinal; pos[j - 1] = i; j--;
      } else {
        const h = H[i - 1], doubled = LET[h] && ((i > 1 && H[i - 2] === h) || (j > 0 && E[j - 1] === h));
        if (opt.trace) opt.trace.push(['', CH[h], Hc ? Hc[i - 1] : 1, '', j, i - 1, Hlen[i - 1]]);
        const paused = wasl(i, j, h);
        const eh = paused ? -1 : endHar(j, h);
        if (eh >= 0 && !seen[eh]) { bad[eh] += 1; type[eh] ||= 1; }
        else if (eh < 0 && INST[h] && !doubled && !paused && !unsure(i - 1) && j > 0 && j < m && !seen[j]) { bad[j] += INSC[h]; type[j] ||= INST[h]; }
        i--;
      }
    }
    // begun at a word, then gone back to one before it (a false start: the words of another aya
    // after the one read, said and left): the reading is from that one, not from the false start
    if (opt.freeStart && back0 < start) start = back0;
    const refs = expected.refs;
    const tj = opt.tajweed || opt.onTj ? tajweed(E, expected._len, expected._w, H, Hlen, Hc, al, pos, end, opt.onTj, opt.tjSkip || expected._tj, expected.ends ? new Set(expected.ends) : null, typeof opt.tajweed === 'object' ? opt.tajweed : undefined, Hdur) : null;
    const out = expected._w.map(([a, b], wi) => {
      if (b <= start) return { state: 'pre' };
      if (a >= end) return { state: 'todo' };
      // haraka mistakes and letter mistakes are weighed apart: a haraka said wrong
      // is a mistake; letters only make a different word when fewer than half
      // of the word's letters were heard, or four were off (two or three
      // misheard letters are common on a phone's microphone)
      // (a doubled letter, or a ghunna's run of م/ن, is one sound for whether the word was heard)
      let har = 0, letc = 0, tl = 0, sim = 0, st = 0, heardTxt = '', decided = true, hits = 0, len = 0, lets = 0, lhits = 0;
      for (let k = a; k < Math.min(b, end); k++) {
        if (type[k] === 1) har += bad[k]; else if (type[k] === 7 || type[k] === 8) { sim += bad[k]; st ||= type[k]; } else { letc += bad[k]; tl ||= type[k]; }
        heardTxt += got[k]; decided &&= !!fin[k];
        if (k > a && LET[E[k]] && E[k - 1] === E[k]) { if (hit[k] && !hit[k - 1]) { hit[k - 1] = 1; hits++; } }
        else { len++; hits += hit[k]; }
        if (LET[E[k]]) { lets++; lhits += hit[k]; }
      }
      let sum = 0, t = 0;
      // a short word (إِن، لَا، مِن، أَلَا: a few sounds, said quickly, joined into the next by
      // idgham, or first after a pause where its hamza is soft): one of its sounds not heard is
      // the model's, not the reader's, when the rest were; and a haraka in it wrong only if heard surely
      // (opt.fast, a fast reading (hadr): every word so, sounds run together and the model hears less)
      const short = len <= 4 || !!opt.fast, most = hits >= len - 1;
      // (fast: a haraka only where the word was heard whole, all its sounds but one, and the
      // haraka all but surely (FAST_HAR_SURE): in hadr the model hears many of them wrongly; a word
      // another only with under a third of its letters heard)
      let harSure = !short;
      const hsure = opt.fast ? (most ? FAST_HAR_SURE : 2) : SHORT_SURE;
      if (short && har >= 1) for (let k = a; k < Math.min(b, end); k++) if (type[k] === 1 && pos[k] >= 0 && (!Hc || Hc[pos[k]] >= hsure)) harSure = true;
      if (b <= end && b > a && hits * 3 < len) { sum = 1; t = 3; } // most of the word not heard at all: left out
      else if (letc >= 1.2 && (opt.fast ? bag(a, b) * 3 < lets : (lhits < lets * 0.5 || letc >= 2.4) && !(short && most))) { sum = letc; t = tl || 2; }
      else if (sim >= 1) { sum = sim; t = st; }
      else if (har >= 1 && harSure) { sum = har; t = 1; }
      const at = [pos[a], Math.min(b, end) > a ? pos[Math.min(b, end) - 1] + 1 : pos[a]]; // where in the heard units
      if (b > end) return { state: 'hear', heard: heardTxt, at };
      // what was heard for it: from its first sound heard to its last (its first may be the one left out)
      let p0 = -1, p1 = -1;
      for (let k = a; k < Math.min(b, end); k++) if (pos[k] >= 0) { if (p0 < 0) p0 = pos[k]; p1 = pos[k] + 1; }
      const span = p0 >= 0 ? [p0, p1] : null;
      // heard as a real reciter reading it right was heard (near one of the word's
      // references); or, for a word mostly not heard, no further from it than one
      if (sum >= 1 && refs?.[wi] && span) {
        const hu = H.slice(span[0], span[1]), ex = t === 3 ? E.slice(a, b) : null, dh = ex && dist(ex, hu);
        if (refs[wi].some(r => { const ru = units(r); return near(ru, hu) || (ex && dh <= dist(ex, ru) + 0.3); })) sum = 0;
      }
      // tajweed (opt.tajweed): the word said right, but a madd or a ghunna in it not given its length
      if (sum < 1 && opt.tajweed && tj) for (let k = a; k < Math.min(b, end); k++) if (tj[k]) { sum = 1; t = TJ_TYPE[tj[k]]; break; }
      if (sum >= 1) return { state: decided ? 'err' : 'hear', type: TYPES[t], heard: heardTxt, at, span };
      return { state: decided ? 'ok' : 'hear', heard: heardTxt, at };
    });
    out.cost = cost[n * W + end];
    return out;
  }

  // ---- two neighbouring words said in the other order (B A for A B). The alignment alone
  // explains that as one word left out and another said twice, or as wrong letters, and marks
  // whichever fits, often neither of the two. So where a word is marked, the reading is tried
  // against the aya with it and a neighbour swapped; if that explains what was heard clearly
  // better, the two are marked as said out of order, and nothing else for it.
  const SWAP = 0.9; // what the swapped reading must explain better by (a word left out costs up to WSKIP)
  const SWAP_TRY = 4; // pairs tried at most
  function swapped(ex, v) {
    const [sa, ea] = ex.spans[v], [sb, eb] = ex.spans[v + 1], ph = ex.ph;
    const A = ph.slice(sa, ea), gap = ph.slice(ea, sb), B = ph.slice(sb, eb);
    const at = c => c >= sa && c < ea ? c - sa + sa + B.length + gap.length : c >= ea && c < sb ? c - ea + sa + B.length : c >= sb && c < eb ? c - sb + sa : c;
    const e = {};
    for (const k of Object.keys(ex)) if (k[0] !== '_') e[k] = ex[k];
    e.ph = ph.slice(0, sa) + B + gap + A + ph.slice(eb);
    e.spans = ex.spans.map((sp, i) => i === v ? [sa, sa + B.length] : i === v + 1 ? [sa + B.length + gap.length, eb] : sp);
    const sw = i => i === v ? v + 1 : i === v + 1 ? v : i;
    if (ex.wasl) e.wasl = ex.wasl.map(sw);
    if (ex.words) e.words = ex.words.map((_, i) => ex.words[sw(i)]);
    if (ex.refs) e.refs = ex.refs.map((_, i) => ex.refs[sw(i)]);
    if (ex.tj) e.tj = ex.tj.map(at);
    return e;
  }
  // words L..R of an aya (or ayas) as an aya of their own
  function part(ex, L, R) {
    const o = ex.spans[L][0], end = ex.spans[R][1], e = { ph: ex.ph.slice(o, end), spans: ex.spans.slice(L, R + 1).map(([a, b]) => [a - o, b - o]) };
    if (ex.wasl) e.wasl = ex.wasl.filter(i => i >= L && i <= R).map(i => i - L);
    if (ex.words) e.words = ex.words.slice(L, R + 1);
    if (ex.refs) e.refs = ex.refs.slice(L, R + 1);
    if (ex.tj) e.tj = ex.tj.filter(c => c >= o && c < end).map(c => c - o);
    if (ex.ends) e.ends = ex.ends.filter(i => i >= L && i <= R).map(i => i - L);
    return e;
  }
  // tried on the few words about the pair only, and what was heard for them: a whole window
  // read again for each pair tried made a slow phone's page freeze where mistakes were many
  const SWAP_AROUND = 2;
  // a short word "left out" between two said right, with sounds heard between them: said, quickly
  // (the model's garble of it); one really left out leaves next to nothing between its neighbours.
  // After the swap is looked for (a word said elsewhere is first marked left out)
  // (opt.fast: any words "left out" one after another, between two said, with sounds heard in their
  // place, a quarter of theirs or more: said, swallowed; one really left out leaves nothing there)
  function quick(expected, st, heard, opt = {}) {
    let out = st, H = null;
    if (opt.fast) {
      const said = x => (x.state === 'ok' || x.state === 'err') && x.at && x.type !== 'missing';
      // (or no sound heard there, but the time of one: from the last sound before to the first after,
      // longer than two sounds at this reading's pace and half the words' own: the model heard
      // nothing it could write, a word left out leaves no time)
      let T = null;
      if (opt.at) {
        T = []; let u = -1, prev = null, c = 0;
        for (const ch of heard) { if (!(MADD.has(ch) && ch === prev)) T[++u] = opt.at[c]; prev = ch; c++; }
      }
      const timed = (i0, i1, n) => {
        if (!T || i0 < 0 || i1 + 1 >= T.length || T[i0] == null || T[i1 + 1] == null) return false;
        let t = 0, k = 0;
        for (let x = Math.max(0, i0 - 8); x < Math.min(T.length - 1, i1 + 9); x++) { const d = T[x + 1] - T[x]; if (d > 0 && d <= 12) { t += d; k++; } }
        const pace = k >= 6 ? t / k : 3;
        return T[i1 + 1] - T[i0] >= pace * (2 + n / 2);
      };
      for (let wi = 1; wi + 1 < st.length; wi++) {
        if (st[wi].type !== 'missing' || !said(st[wi - 1])) continue;
        let wj = wi; while (wj + 1 < st.length && st[wj + 1].type === 'missing') wj++;
        if (wj + 1 >= st.length || !said(st[wj + 1])) { wi = wj; continue; }
        const g = st[wj + 1].at[0] - st[wi - 1].at[1], n = expected._w[wj][1] - expected._w[wi][0];
        if ((g >= 1 && g <= n + 2) || timed(st[wi - 1].at[1] - 1, st[wj + 1].at[0], n)) {
          if (out === st) { out = st.slice(); out.cost = st.cost; }
          for (let k = wi; k <= wj; k++) out[k] = { state: st[k].state === 'err' ? 'ok' : st[k].state, heard: st[k].heard, at: st[k].at };
        }
        wi = wj;
      }
      return out;
    }
    for (let wi = 1; wi + 1 < st.length; wi++) {
      const x = st[wi], p = st[wi - 1], q = st[wi + 1], [a, b] = expected._w[wi];
      if (x.type !== 'missing' || p.state !== 'ok' || q.state !== 'ok' || !p.at || !q.at || b - a > 4) continue;
      const g0 = p.at[1], g1 = q.at[0];
      if (g1 - g0 < (opt.fast ? Math.max(1, Math.ceil((b - a) / 3)) : Math.max(2, b - a - 1)) || g1 - g0 > b - a + 2) continue;
      // (and like it: a letter of it among them, not another word said in its place)
      H ||= units(heard);
      const gap = H.slice(g0, g1), E = expected._u;
      let like = false;
      for (let k = a; k < b && !like; k++) if (LET[E[k]]) like = gap.some(h => h === E[k] || alike.has(CH[E[k]] + CH[h]));
      if (!like) continue;
      if (out === st) { out = st.slice(); out.cost = st.cost; }
      out[wi] = { state: x.state === 'err' ? 'ok' : x.state, heard: x.heard, at: x.at };
    }
    return out;
  }
  function words(expected, heard, finalLen = heard.length, done = false, opt = {}) {
    const st = core(expected, heard, finalLen, done, opt);
    if (opt.noSwap || expected.spans.length < 2) return opt.noSwap ? st : quick(expected, st, heard, opt);
    const ends = expected.ends ? new Set(expected.ends) : null, ph = expected.ph, sp = expected.spans;
    const word = i => ph.slice(sp[i][0], sp[i][1]);
    const said = i => (st[i].state === 'ok' || st[i].state === 'err') && st[i].at;
    const pairs = [];
    st.forEach((x, k) => {
      if (x.state !== 'err' || x.type === 'haraka' || x.type === 'madd' || x.type === 'ghunna') return;
      for (const v of [k - 1, k]) if (v >= 0 && v + 1 < sp.length && !pairs.includes(v) && !ends?.has(v)
        && sp[v][1] > sp[v][0] && sp[v + 1][1] > sp[v + 1][0] && word(v) !== word(v + 1) && said(v) && said(v + 1)) pairs.push(v);
    });
    if (!pairs.length) return quick(expected, st, heard, opt);
    const H = units(heard);
    let out = null;
    for (const v of pairs.slice(0, SWAP_TRY)) {
      // the words about the pair, each said (so where they were heard is known), and what was heard for them
      let L = v, R = v + 1;
      while (L > 0 && v - L < SWAP_AROUND && said(L - 1) && !ends?.has(L - 1)) L--;
      while (R + 1 < sp.length && R - v - 1 < SWAP_AROUND + 1 && said(R + 1) && !ends?.has(R)) R++;
      // (to where the next word begins: a word said out of place may have been put down to it)
      const span = [...Array(R - L + 1).keys()].map(i => st[L + i].at);
      // (and from where the word before ended, or the start: a word said first may have been taken for a lead-in)
      const pv = st[L - 1], nx = st[R + 1];
      const u0 = Math.min(...span.map(x => x[0]), L === 0 ? 0 : pv?.at ? pv.at[1] : Infinity);
      const u1 = Math.max(...span.map(x => x[1]), nx?.at && nx.state !== 'todo' ? nx.at[0] : R + 1 >= sp.length ? H.length : 0);
      if (!(u1 > u0)) continue;
      const c0 = charAt(heard, u0), c1 = charAt(heard, u1), sub = heard.slice(c0, c1);
      const o = { ...opt, freeLead: false, freeStart: false, noSwap: true };
      if (opt.conf) o.conf = opt.conf.slice(c0, c1);
      if (opt.alts) o.alts = opt.alts.slice(c0, c1);
      const loc = part(expected, L, R), here = core(loc, sub, sub.length, true, o);
      const s2 = core(swapped(loc, v - L), sub, sub.length, true, o), a = v - L;
      if (!(s2.cost + SWAP < here.cost - 1e-6) || s2[a].state === 'err' || s2[a + 1].state === 'err') continue;
      // the swap explains it: the two marked as said out of order, the words about them as the swapped reading has them
      out ||= st.slice();
      const back = x => x.at ? { ...x, at: [x.at[0] + u0, x.at[1] + u0], span: x.span && [x.span[0] + u0, x.span[1] + u0] } : x;
      for (let i = L; i <= R; i++) {
        const x = back(s2[i === v ? a + 1 : i === v + 1 ? a : i - L]);
        out[i] = i === v || i === v + 1 ? { state: 'err', type: 'order', heard: x.heard, at: x.at, span: x.at } : x;
      }
    }
    if (!out) return quick(expected, st, heard, opt);
    out.cost = st.cost;
    return quick(expected, out, heard, opt);
  }

  // two hearings of one word: alike, by the same costs (similar letters, madd,
  // marks), within less than one wrong letter or haraka
  // how far apart two hearings are, by the same costs
  function dist(x, y) {
    grow();
    const n = x.length, m = y.length;
    let prev = new Float32Array(m + 1), cur = new Float32Array(m + 1);
    for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + INSC[y[j - 1]];
    for (let i = 1; i <= n; i++) {
      cur[0] = prev[0] + DELC[x[i - 1]];
      for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j - 1] + SUBC[x[i - 1] * K + y[j - 1]], prev[j] + DELC[x[i - 1]], cur[j - 1] + INSC[y[j - 1]]);
      [prev, cur] = [cur, prev];
    }
    return prev[m];
  }
  const NEAR = 0.55;
  function near(x, y) {
    grow();
    const n = x.length, m = y.length;
    if (Math.abs(n - m) > 4) return false;
    let prev = new Float32Array(m + 1), cur = new Float32Array(m + 1);
    for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + INSC[y[j - 1]];
    for (let i = 1; i <= n; i++) {
      cur[0] = prev[0] + DELC[x[i - 1]];
      let best = cur[0];
      for (let j = 1; j <= m; j++) {
        cur[j] = Math.min(prev[j - 1] + SUBC[x[i - 1] * K + y[j - 1]], prev[j] + DELC[x[i - 1]], cur[j - 1] + INSC[y[j - 1]]);
        if (cur[j] < best) best = cur[j];
      }
      if (best > NEAR) return false;
      [prev, cur] = [cur, prev];
    }
    return prev[m] <= NEAR;
  }

  // the aya's units, and each word as a [start, end) range of units
  function prepare(ex) {
    const u = [], at = new Int32Array(ex.ph.length + 1), len = [];
    let k = 0;
    for (const c of ex.ph) {
      at[k] = u.length;
      const i = id(c);
      if (!(MADD.has(c) && u.length && u[u.length - 1] === i)) { u.push(i); len.push(1); }
      else len[len.length - 1]++;
      k += c.length;
    }
    at[k] = u.length;
    ex._u = u; ex._len = len; // (_len: how many of the char each unit is: a madd's or a ghunna's length)
    // tajweed not checked at these places (ex.tj: character offsets in ph)
    ex._tj = ex.tj?.length ? new Set(ex.tj.map(c => at[c])) : null;
    ex._w = ex.spans.map(([a, b]) => [at[a], b > a ? Math.max(at[a] + 1, at[b]) : at[a]]);
    // 1: the last two units of a word (where a pause changes the sound),
    // 2: the first unit of a word starting with hamzat al-wasl (ٱ), said with ء after a pause
    ex._edge = new Uint8Array(u.length);
    ex._w.forEach(([a, b], i) => {
      if (b <= a) return;
      ex._edge[b - 1] = 1; if (b - 2 >= a) ex._edge[b - 2] = 1;
      if ((ex.wasl ? ex.wasl.includes(i) : ex.words?.[i]?.startsWith('ٱ')) && !ex._edge[a]) ex._edge[a] = 2;
    });
  }

  // ---- tajweed: a madd's length and a ghunna's, as heard against as expected
  // (the model writes a madd as so many ا/ۦ/ۥ, a ghunna as a run of ن/م/ں: idgham
  // and ikhfa included). Returns per expected unit 0, or which rule was missed.
  const MADDS = new Set(['ا', 'ۦ', 'ۥ'].map(id)), NASAL = new Set(['ن', 'م', 'ں', '۾'].map(id));
  // a madd's kind, from what follows it: 'arid' (before the aya's last letter, at the stop:
  // 2, 4 or 6 all right), 'muttasil' (a hamza in its word), 'munfasil' (a hamza starting
  // the next word), 'lazim' (a sukun or shadda after it), else 'tabii' (two counts)
  // the unit is its word's last (or the haraka before it): where a stop changes a word's end
  const wordEnd = (W, k) => W.some(([a, b]) => k >= a && k < b && k + 2 >= b);
  function maddKind(E, W, k, ends) {
    const w = W.findIndex(([a, b]) => k >= a && k < b), [, b] = W[w] || [0, E.length];
    // (a word inside the aya, at a stop sign, is written with its last haraka, which the stop drops)
    if ((ends ? ends.has(w) : w === W.length - 1) && (k + 2 >= b || (k + 3 >= b && ISHAR[E[b - 1]]))) return 'arid';
    const nx = E[k + 1];
    if (nx === HAMZA) return k + 1 < b ? 'muttasil' : 'munfasil';
    if (k + 1 < b && LET[nx] && (k + 2 >= b || !ISHAR[E[k + 2]])) return 'lazim';
    return 'tabii';
  }
  // the rules checked (what correct reciters do, from the study: a natural madd is heard
  // 2 counts, a muttasil 4, a ghunna 3 or 4; the munfasil (4, or 2 read with qasr) and a
  // madd at the stop (2, 4 or 6) are left to the reader):
  //   madd: a natural madd not said (its haraka alone), a muttasil or lazim said natural
  //   ghunna: a ghunna (idgham, ikhfa, iqlab, a doubled ن/م) said without its length
  // skip: expected units where correct reciters are heard otherwise (data/tj-*.json)
  //   over (the madd beyond its length, the study: correct reciters hold a natural madd 3 counts or
  //   more 0.08% of the time, and give a short vowel a madd of 2 or more 0.01%):
  //     a natural madd inside a word held OVER_LONG counts or more (at a word's end it may be a stop: left)
  //     a short vowel inside a word drawn out into a madd of OVER_NONE or more
  const TJ_MADD = 1, TJ_GHUNNA = 2, TJ_LONG = 3, TJ_NONE = 4, TJ_SURE = 0.8;
  // how far off it must be: readers of tarteel (not the study's professionals) say a natural madd
  // anywhere from 1 count to 3 (4 only at a stop sign, where it may be a stop), and give a short vowel
  // 2, often enough that those were marked in correct readings; so a natural madd is short only when
  // not heard at all (the professionals' are heard 1 count 17% of the time)
  const OVER_LONG = 4, OVER_NONE = 3;
  // and each reader holds a madd their own length (and the model hears a fast reader's shorter):
  // rules.pace { u: how long this reader's natural madd is heard (its middle), z: how often it is
  // heard as nothing, n: how many measured }, from their own readings (recite.js), the limits
  // set from it: too long only from twice their natural madd and more (5 for one of 2), a
  // muttasil or lazim short only as short as their natural one, a short vowel drawn out only
  // from 2 beyond their natural madd; a natural madd missing only for a reader the model
  // seldom hears so (some readers' come out as nothing often, said right)
  // And in time (the model may write one reader's 2 counts and another's 4 alike): p.t, how long
  // this reader's natural madd is held (frames, p.tn measured); a madd is then marked only when
  // its time says so too: too long only if held 1¾ times their natural one or more, a muttasil or
  // lazim short only if held under 1¼ times it (3 counts to 6 all right: under 2½ is short; with
  // no time measured yet, only when heard 1 letter), a short vowel drawn out only if held as long
  // rules.seen(k, hl, d): each natural madd inside a word, as heard, and its time (for the pace)
  const PACE_N = 30;
  function limits(p) {
    const u = p && p.n >= PACE_N ? Math.min(3, Math.max(1, p.u)) : 2, z = p && p.n >= PACE_N ? p.z : 0;
    return { long: Math.max(OVER_LONG + 1, Math.round(2 * u) + 1), short: Math.min(2, Math.round(u)), none: Math.max(OVER_NONE + 1, Math.round(u) + 2), miss: z < 0.12, t: p && p.tn >= PACE_N ? p.t : 0 };
  }
  const TJ_TYPE = [0, 5, 6, 9, 10]; // the mistake type (TYPES) of each
  // rules: { madd, ghunna, munfasil } which are checked (munfasil: held 4, not read short with qasr)
  function tajweed(E, Elen, W, H, Hlen, Hc, al, pos, end, onTj, skip, ends, rules = { madd: true, ghunna: true }, Hdur = null) {
    const out = new Uint8Array(E.length), sure = i => !Hc || Hc[i] >= TJ_SURE, L = limits(rules.pace);
    // held (in this reader's natural madds) at least x times / under x times; not known: as the letters say
    const held = i => L.t && Hdur && Hdur[i] > 0 ? Hdur[i] / L.t : null;
    const atLeast = (i, x) => { const r = held(i); return r == null || r >= x; }, under = (i, x) => { const r = held(i); return r == null || r < x; };
    for (let k = 0; k < Math.min(end, E.length); k++) {
      if (!MADDS.has(E[k]) || Elen[k] < 2 || skip?.has(k)) continue;
      const kind = maddKind(E, W, k, ends), i = al[k] ? pos[k] : -1, hl = i >= 0 && MADDS.has(H[i]) ? Hlen[i] : 0;
      onTj?.('madd-' + kind, Elen[k], hl, i >= 0 && Hc ? Hc[i] : 1, k);
      // the sound before it heard (its haraka, its letter): the word was said here
      const around = k > 0 && al[k - 1] && sure(pos[k - 1]);
      // (and the sound after it: the madd between two heard surely)
      const after = k + 1 < E.length && al[k + 1] && sure(pos[k + 1]);
      if (kind === 'tabii' && around && (i < 0 || sure(i)) && !wordEnd(W, k)) rules.seen?.(k, hl, hl && Hdur ? Hdur[i] : -1);
      if (!rules.madd && !rules.over) continue;
      // (ī or ū heard as ay or aw: the madd heard as its letter, said)
      const diph = i >= 0 && k > 0 && DIPH.get(E[k - 1])?.[0] === E[k] && H[i] === DIPH.get(E[k - 1])[1];
      // a madd not heard at all (a fatha where an alif should be): with rules.goneOften, marked only once
      // this reader is heard so often enough (the caller counts each one: rules.gone(k), rules.goneOften(k))
      const gone = () => { if (!rules.goneOften) return true; rules.gone?.(k); return rules.goneOften(k); };
      if (rules.madd && L.miss && kind === 'tabii' && !hl && !diph && around && after && (i < 0 || sure(i)) && gone()) out[k] = TJ_MADD;
      if (rules.over && kind === 'tabii' && hl >= L.long && i >= 0 && sure(i) && !wordEnd(W, k) && atLeast(i, 1.75)) out[k] = TJ_LONG;
      if (rules.madd && (kind === 'muttasil' || kind === 'lazim' || (kind === 'munfasil' && rules.munfasil)) && Elen[k] >= 4 && hl <= (L.t && Hdur ? L.short : 1) && i >= 0 && sure(i) && under(i, 1.25) && (hl || gone())) out[k] = TJ_MADD;
      if (out[k]) onTj?.('flag', out[k], hl, 0, k);
    }
    // (after a word with a stop sign the reader may stop: its tanween or ن is then not merged into
    // the next word, and there is no ghunna to give: طِبَاقًاۖ مَّا read طِبَاقَا | مَا)
    const stopAt = ends ? [...ends].filter(w => w < W.length - 1).map(w => W[w][1]) : [];
    for (let k = 0; k < Math.min(end, E.length);) {
      if (!NASAL.has(E[k])) { k++; continue; }
      let e = k, ge = 0, lo = Infinity, hi = -1;
      while (e < E.length && NASAL.has(E[e])) { ge += Elen[e]; if (al[e]) { lo = Math.min(lo, pos[e]); hi = Math.max(hi, pos[e]); } e++; }
      if (rules.ghunna && ge >= 3 && e <= end && !skip?.has(k) && !stopAt.some(b => k <= b + 1 && e >= b - 1)) {
        let gh = 0, ok = hi >= 0;
        if (hi >= 0) {
          while (lo > 0 && NASAL.has(H[lo - 1])) lo--;
          while (hi + 1 < H.length && NASAL.has(H[hi + 1])) hi++;
          for (let i = lo; i <= hi; i++) { if (NASAL.has(H[i])) gh += Hlen[i]; ok &&= sure(i); }
        }
        onTj?.('ghunna', ge, gh, 1, k);
        if (ok && gh <= 1) { out[k] = TJ_GHUNNA; onTj?.('flag', TJ_GHUNNA, gh, 0, k); }
      }
      k = e;
    }
    // a madd where there is none: heard, lined up with nothing, after a short vowel inside a word
    if (rules.over) {
      const took = new Uint8Array(H.length);
      let last = -1;
      for (let k = 0; k < Math.min(end, E.length); k++) if (al[k] && pos[k] >= 0) { took[pos[k]] = 1; last = Math.max(last, pos[k]); }
      for (let i = 0, k = -1; i <= last; i++) {
        while (k + 1 < Math.min(end, E.length) && (!al[k + 1] || pos[k + 1] < i)) k++; // the expected unit before it
        if (took[i] || !MADDS.has(H[i]) || Hlen[i] < L.none || !sure(i) || k < 0 || !al[k] || !ISHAR[E[k]]) continue;
        if (k + 1 >= E.length || wordEnd(W, k) || MADDS.has(E[k + 1]) || skip?.has(k)) continue;
        if (!out[k] && atLeast(i, 1)) { out[k] = TJ_NONE; onTj?.('flag', TJ_NONE, Hlen[i], 0, k); }
      }
    }
    // idgham (مِن رَّبِّهِم: مِرَّبِّ, without ghunna; مَن يَقُولُ: مَيييَقُول and مِن وَالٍ: مِووَال, with it):
    // the ن said where it merges into the doubled ل or ر, or the ي or و drawn out with its ghunna (izhar)
    for (let k = 1; k + 1 < Math.min(end, E.length); k++) {
      const into = ((E[k] === LAM || E[k] === RA) && E[k + 1] === E[k]) || ((E[k] === YA || E[k] === WAW) && E[k + 1] === E[k] && E[k + 2] === E[k]);
      if (!rules.ghunna || !into || !ISHAR[E[k - 1]] || skip?.has(k)) continue;
      const i = al[k] ? pos[k] : -1, j = al[k + 1] ? pos[k + 1] : -1;
      const nun = (i >= 0 && H[i] === NUN && sure(i)) || (j > 0 && H[j - 1] === NUN && (i < 0 || i === j - 1) && sure(j - 1));
      onTj?.('idgham', 2, nun ? 1 : 0, 1, k);
      if (nun && !out[k]) { out[k] = TJ_GHUNNA; onTj?.('flag', TJ_GHUNNA, 1, 0, k); }
    }
    return out;
  }

  // each unit's confidence, from each character's (as units() groups them)
  function unitConf(s, conf) {
    if (!conf) return [];
    const out = [];
    let prev = null, k = 0;
    for (const c of s) {
      const v = conf?.[k++] ?? 1;
      if (MADD.has(c) && c === prev) out[out.length - 1] = Math.max(out[out.length - 1], v);
      else out.push(v);
      prev = c;
    }
    return out;
  }

  // each unit's runner-up sounds (a string), as units() groups the characters
  function unitAlts(s, alts) {
    const out = [];
    if (!alts) return out;
    let prev = null, k = 0;
    for (const c of s) {
      const a = alts[k++] || '', v = typeof a === 'string' ? a : Object.keys(a).filter(y => a[y] >= ALT_MIN).join('');
      if (MADD.has(c) && c === prev) out[out.length - 1] += v; else out.push(v);
      prev = c;
    }
    return out;
  }

  // where unit u starts in s (a madd's run whole; s.length past the last)
  function charAt(s, u) {
    let n = -1, prev = null, k = 0;
    for (const c of s) {
      if (!(MADD.has(c) && c === prev)) { n++; if (n === u) return k; }
      prev = c; k += c.length;
    }
    return s.length;
  }

  return { words, units, unitConf, unitAlts, charAt, text: u => u.map(i => CH[i]).join(''), pairType: pk => TYPES[PAIR.get(pk)] };
})();
if (typeof module !== 'undefined') module.exports = Match;
