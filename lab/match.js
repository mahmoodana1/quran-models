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
  const TYPES = [null, 'haraka', 'letter', 'missing', 'extra'];
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
  const NUN = id('ن'), HAMZA = id('ء');

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
  const UNSURE = 0.6; // below this confidence, a heard sound is not trusted to show a mistake
  const ALT_MIN = 0.1; // a runner-up sound given at least this chance
  const REPEAT = 1.2, REPEAT_WORDS = 12; // going back to say words again: its cost (no mistake), and how far back

  // expected: { ph, spans: [[start, end) per word] } in script characters,
// and which words start with hamzat al-wasl: wasl (indices) or words (text)
  // heard: the model's text so far; finalLen: how much of it is final;
  // done: the reciter stopped, so the whole aya must be accounted for
  // opt.freeLead: what was heard before the aya (a basmala, an isti'adha) costs nothing
  // opt.freeStart: the reading may begin at any word (those before it: state 'pre')
  // opt.conf: how sure the model was of each heard character (0..1); a mismatch
  // on a sound it was unsure of is taken for a mishearing, never a mistake
  // opt.alts: per heard character, the other sounds the model gave a fair chance
  // (a string, or { sound: chance }); when the expected sound is one, it counts as heard
  // expected.refs (optional): per word, how real reciters reading it right were
  // heard (where that differs from how it should sound); a word heard like one
  // of them is not a mistake
  // returns per word { state: 'ok'|'err'|'hear'|'todo', type, heard, at }
  function words(expected, heard, finalLen = heard.length, done = false, opt = {}) {
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
    if (opt.freeStart) for (const [a] of expected._w) if (a > 0 && a < m) { cost[a] = 0; back[a] = 0; }
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
    }
    let end = m;
    if (!done) { end = 0; for (let j = 1, r = n * W; j <= m; j++) if (cost[r + j] < cost[r + end] - 1e-6) end = j; }
    // walk back: what happened to each expected unit
    const bad = new Float32Array(m + 1), type = new Uint8Array(m + 1), got = new Array(m).fill(''), fin = new Uint8Array(m), pos = new Int32Array(m).fill(-1);
    const hit = new Uint8Array(m); // the unit was heard (as itself, or as a sound it is confused with)
    const seen = new Uint8Array(m + 1); // judged already: from a later attempt (said again), which is the one that counts
    let i = n, j = end, steps = 0, start = 0;
    while (i > 0 || j > 0) {
      if (i === 0 && opt.freeStart && back[j] === 0) { start = j; break; }
      if (++steps > (n + m) * 3 + 64) break; // can't happen; never hang the page if it did
      const b = back[i * W + j];
      if (b === 4) { const f = jump[i * nw + wordAt[j]]; if (f < 0 || f <= j) break; j = f; continue; }
      if ((b === 1 || b === 2) && seen[j - 1]) { if (b === 1) i--; j--; continue; }
      if (b === 1 || b === 2) seen[j - 1] = 1;
      if (b === 1) {
        const x = E[j - 1] * K + H[i - 1];
        const fine = unsure(i - 1) || runnerUp(i - 1, E[j - 1]);
        if (SUBT[x] && subc(j - 1, H[i - 1]) === SUBC[x] && !fine) { bad[j - 1] += SUBC[x]; type[j - 1] ||= SUBT[x]; }
        hit[j - 1] = subc(j - 1, H[i - 1]) <= PAUSE || fine ? 1 : 0;
        got[j - 1] = CH[H[i - 1]]; fin[j - 1] = i <= hFinal; pos[j - 1] = i - 1; i--; j--;
      } else if (b === 2) {
        if (dbad[j - 1] && !(wh[j - 1] && back[i * W + j - 1] === 2)) { bad[j - 1] += DELC[E[j - 1]]; type[j - 1] ||= DELT[E[j - 1]]; }
        fin[j - 1] = i <= hFinal; pos[j - 1] = i; j--;
      } else {
        const h = H[i - 1], doubled = LET[h] && ((i > 1 && H[i - 2] === h) || (j > 0 && E[j - 1] === h));
        const paused = wasl(i, j, h);
        const eh = paused ? -1 : endHar(j, h);
        if (eh >= 0 && !seen[eh]) { bad[eh] += 1; type[eh] ||= 1; }
        else if (eh < 0 && INST[h] && !doubled && !paused && !unsure(i - 1) && j > 0 && j < m && !seen[j]) { bad[j] += INSC[h]; type[j] ||= INST[h]; }
        i--;
      }
    }
    const refs = expected.refs;
    return expected._w.map(([a, b], wi) => {
      if (b <= start) return { state: 'pre' };
      if (a >= end) return { state: 'todo' };
      // haraka mistakes and letter mistakes are weighed apart: a haraka said wrong
      // is a mistake; letters only make a different word when fewer than half
      // of the word's letters were heard, or four were off (two or three
      // misheard letters are common on a phone's microphone)
      // (a doubled letter, or a ghunna's run of م/ن, is one sound for whether the word was heard)
      let har = 0, letc = 0, tl = 0, heardTxt = '', decided = true, hits = 0, len = 0, lets = 0, lhits = 0;
      for (let k = a; k < Math.min(b, end); k++) {
        if (type[k] === 1) har += bad[k]; else { letc += bad[k]; tl ||= type[k]; }
        heardTxt += got[k]; decided &&= !!fin[k];
        if (k > a && LET[E[k]] && E[k - 1] === E[k]) { if (hit[k] && !hit[k - 1]) { hit[k - 1] = 1; hits++; } }
        else { len++; hits += hit[k]; }
        if (LET[E[k]]) { lets++; lhits += hit[k]; }
      }
      let sum = 0, t = 0;
      if (b <= end && b > a && hits * 3 < len) { sum = 1; t = 3; } // most of the word not heard at all: left out
      else if (letc >= 1.2 && (lhits < lets * 0.5 || letc >= 2.4)) { sum = letc; t = tl || 2; }
      else if (har >= 1) { sum = har; t = 1; }
      const at = [pos[a], Math.min(b, end) > a ? pos[Math.min(b, end) - 1] + 1 : pos[a]]; // where in the heard units
      if (b > end) return { state: 'hear', heard: heardTxt, at };
      if (sum >= 1 && refs?.[wi] && at[0] >= 0 && refs[wi].some(r => near(units(r), H.slice(at[0], at[1])))) sum = 0;
      if (sum >= 1) return { state: decided ? 'err' : 'hear', type: TYPES[t], heard: heardTxt, at };
      return { state: decided ? 'ok' : 'hear', heard: heardTxt, at };
    });
  }

  // two hearings of one word: alike, by the same costs (similar letters, madd,
  // marks), within less than one wrong letter or haraka
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
    const u = [], at = new Int32Array(ex.ph.length + 1);
    let k = 0;
    for (const c of ex.ph) {
      at[k] = u.length;
      const i = id(c);
      if (!(MADD.has(c) && u.length && u[u.length - 1] === i)) u.push(i);
      k += c.length;
    }
    at[k] = u.length;
    ex._u = u;
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

  return { words, units, unitConf, unitAlts, text: u => u.map(i => CH[i]).join('') };
})();
if (typeof module !== 'undefined') module.exports = Match;
