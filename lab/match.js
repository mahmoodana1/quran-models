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
// A wrong haraka is a mistake; a single wrong, missing or extra letter in a
// word is forgiven (the model mishears some letters even from the best
// reciters: غ as ر, خ as ق, …), two in the same word are a mistake.
const Match = (() => {
  const HARAKA = new Set(['َ', 'ُ', 'ِ']);
  const MADD = new Set(['ا', 'ۦ', 'ۥ', 'ں']);           // runs of these are one unit
  const MARK = new Set(['ڇ', 'ۜ', 'ؙ', '۪', 'ٲ', 'ـ', '۾']);
  const GROUPS = ['منں۾', 'تط', 'دض', 'سصث', 'ذزظ', 'قك', 'ءع', 'هح', 'يۦ', 'وۥ', 'اء'];
  const group = new Map();
  GROUPS.forEach((g, i) => [...g].forEach(c => { if (!group.has(c)) group.set(c, i); }));

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
  let K = 0, built = 0, SUBC, SUBT, DELC, DELT, INSC, INST, LET;
  // (re)build the tables when sounds were added
  function grow() {
    const n = CH.length;
    if (n === built) return;
    built = n; K = Math.max(64, n);
    SUBC = new Float32Array(K * K); SUBT = new Uint8Array(K * K);
    DELC = new Float32Array(K); DELT = new Uint8Array(K); INSC = new Float32Array(K); INST = new Uint8Array(K); LET = new Uint8Array(K);
    for (let x = 0; x < n; x++) {
      const a = [CH[x], kind(CH[x])];
      [DELC[x], DELT[x]] = cost1(del(a)); [INSC[x], INST[x]] = cost1(ins(a)); LET[x] = a[1] === 'l' ? 1 : 0;
      for (let y = 0; y < n; y++) [SUBC[x * K + y], SUBT[x * K + y]] = cost1(sub(a, [CH[y], kind(CH[y])]));
    }
  }
  const cost1 = ([c, t]) => [c, TYPES.indexOf(t)];
  [...'ءبتثجحخدذرزسشصضطظعغفقكلمنهويا' + 'ۦۥَُِ۪ـٲڇں۾ؙۜ'].forEach(id);

  function sub(a, b) {
    if (a[0] === b[0]) return [0, null];
    if (a[1] === 'm' || b[1] === 'm') return [0.15, null];
    const ga = group.get(a[0]), gb = group.get(b[0]);
    if (ga != null && ga === gb) return [0.2, null];
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

  // expected: { ph, spans: [[start, end) per word] } in script characters
  // heard: the model's text so far; finalLen: how much of it is final;
  // done: the reciter stopped, so the whole aya must be accounted for
  // returns per word { state: 'ok'|'err'|'hear'|'todo', type, heard }
  function words(expected, heard, finalLen = heard.length, done = false) {
    if (!expected._u) prepare(expected);
    const E = expected._u, H = units(heard);
    const hFinal = units(heard.slice(0, finalLen)).length;
    grow();
    const n = H.length, m = E.length, W = m + 1;
    const cost = new Float32Array((n + 1) * W), back = new Uint8Array((n + 1) * W);
    const dcost = new Float32Array(m);  // deleting E[j], with the shadda allowance
    for (let j = 0; j < m; j++) dcost[j] = LET[E[j]] && j && E[j - 1] === E[j] ? SHADDA : DELC[E[j]];
    for (let j = 1; j <= m; j++) { cost[j] = cost[j - 1] + dcost[j - 1]; back[j] = 2; }
    for (let i = 1; i <= n; i++) {
      const r = i * W, p = r - W, h = H[i - 1];
      const ic = LET[h] && i > 1 && H[i - 2] === h ? SHADDA : INSC[h];
      cost[r] = cost[p] + ic; back[r] = 3;
      for (let j = 1; j <= m; j++) {
        let c = cost[p + j - 1] + SUBC[E[j - 1] * K + h], b = 1;
        const d = cost[r + j - 1] + dcost[j - 1];
        if (d < c) { c = d; b = 2; }
        const s = cost[p + j] + (LET[h] && E[j - 1] === h ? SHADDA : ic);
        if (s < c) { c = s; b = 3; }
        cost[r + j] = c; back[r + j] = b;
      }
    }
    let end = m;
    if (!done) { end = 0; for (let j = 1, r = n * W; j <= m; j++) if (cost[r + j] < cost[r + end] - 1e-6) end = j; }
    // walk back: what happened to each expected unit
    const bad = new Float32Array(m + 1), type = new Uint8Array(m + 1), got = new Array(m).fill(''), fin = new Uint8Array(m), pos = new Int32Array(m).fill(-1);
    let i = n, j = end;
    while (i > 0 || j > 0) {
      const b = back[i * W + j];
      if (b === 1) {
        const x = E[j - 1] * K + H[i - 1];
        if (SUBT[x]) { bad[j - 1] += SUBC[x]; type[j - 1] ||= SUBT[x]; }
        got[j - 1] = CH[H[i - 1]]; fin[j - 1] = i <= hFinal; pos[j - 1] = i - 1; i--; j--;
      } else if (b === 2) {
        if (DELT[E[j - 1]] && dcost[j - 1] !== SHADDA) { bad[j - 1] += DELC[E[j - 1]]; type[j - 1] ||= DELT[E[j - 1]]; }
        fin[j - 1] = i <= hFinal; pos[j - 1] = i; j--;
      } else {
        const h = H[i - 1], doubled = LET[h] && ((i > 1 && H[i - 2] === h) || (j > 0 && E[j - 1] === h));
        if (INST[h] && !doubled && j > 0 && j < m) { bad[j] += INSC[h]; type[j] ||= INST[h]; }
        i--;
      }
    }
    return expected._w.map(([a, b]) => {
      if (a >= end) return { state: 'todo' };
      let sum = 0, t = 0, heardTxt = '', decided = true;
      for (let k = a; k < Math.min(b, end); k++) { sum += bad[k]; t ||= type[k]; heardTxt += got[k]; decided &&= !!fin[k]; }
      const at = [pos[a], Math.min(b, end) > a ? pos[Math.min(b, end) - 1] + 1 : pos[a]]; // where in the heard units
      if (b > end) return { state: 'hear', heard: heardTxt, at };
      if (sum >= 1) return { state: decided ? 'err' : 'hear', type: TYPES[t], heard: heardTxt, at };
      return { state: decided ? 'ok' : 'hear', heard: heardTxt, at };
    });
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
  }

  return { words, units, text: u => u.map(i => CH[i]).join('') };
})();
if (typeof module !== 'undefined') module.exports = Match;
