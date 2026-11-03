'use strict';

// The candidates: one model file (8-bit, 4-bit or fp16) on one backend.
// The download cache is keyed by each part's hash, so a page update never
// throws away models already on the phone.
const CANDS = [
  { id: 'q8-cpu', variant: 'q8', ep: 'wasm', name: '8-bit · CPU', mb: 126 },
  { id: 'q8-gpu', variant: 'q8', ep: 'webgpu', name: '8-bit · GPU', mb: 126 },
  { id: 'fp16-gpu', variant: 'fp16', ep: 'webgpu', name: 'fp16 · GPU', mb: 234, f16: true },
  { id: 'q4-cpu', variant: 'q4', ep: 'wasm', name: '4-bit · CPU', mb: 86 },
  { id: 'q4-gpu', variant: 'q4', ep: 'webgpu', name: '4-bit · GPU', mb: 86 },
];
// everyayah.com folders; each recites every aya on its own, correctly
const RECITERS = [
  ['Husary_64kbps', 'Al-Husary'], ['Alafasy_128kbps', 'Mishary Alafasy'], ['Minshawy_Murattal_128kbps', 'Al-Minshawi'],
  ['Abdul_Basit_Murattal_192kbps', 'Abdul Basit'], ['Abdurrahmaan_As-Sudais_192kbps', 'As-Sudais'], ['Saood_ash-Shuraym_128kbps', 'Ash-Shuraym'],
  ['Yasser_Ad-Dussary_128kbps', 'Yasser Ad-Dussary'], ['Ghamadi_40kbps', 'Al-Ghamdi'], ['Maher_AlMuaiqly_64kbps', 'Maher Al-Muaiqly'],
  ['Hudhaify_128kbps', 'Al-Hudhaify'], ['Muhammad_Ayyoub_128kbps', 'Muhammad Ayyoub'], ['Abu_Bakr_Ash-Shaatree_128kbps', 'Ash-Shatri'],
];
const run_ = (s, a0, a1) => Array.from({ length: a1 - a0 + 1 }, (_, i) => [s, a0 + i]);
const SETS = [
  ['quick', 'Quick · 6 ayat', [[1, 2], [1, 7], [112, 1], [103, 2], [67, 1], [55, 3]]],
  ['fatiha', 'Al-Fatiha · 7 ayat', run_(1, 1, 7)],
  ['short', 'Short surahs · 21 ayat', [...run_(103, 1, 3), ...run_(108, 1, 3), ...run_(112, 1, 4), ...run_(113, 1, 5), ...run_(114, 1, 6)]],
  ['mulk', 'Al-Mulk 1–10', run_(67, 1, 10)],
  ['rahman', 'Ar-Rahman 1–13', run_(55, 1, 13)],
  ['kursi', 'Ayat al-Kursi', [[2, 255]]],
  ['all', 'Everything · 52 ayat', null],
];
const RATE = 16000;
const $ = s => document.querySelector(s);
const ar = n => String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let AYAT = [];

// ---- cross-origin isolation (several cores) through sw.js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => {
    if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
      sessionStorage.setItem('coi-reloaded', '1');
      navigator.serviceWorker.ready.then(() => location.reload());
    }
  });
}

// ---- the device and the choices
let gpu = null;
async function device() {
  let g = 'not available';
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (a) { gpu = { f16: a.features.has('shader-f16') }; g = [a.info?.vendor, a.info?.architecture].filter(Boolean).join(' ') + (gpu.f16 ? ' · fp16 yes' : ' · fp16 no'); }
  } catch {}
  const rows = [
    ['Browser', navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90)],
    ['CPU cores', navigator.hardwareConcurrency || '?'],
    ['Memory', navigator.deviceMemory ? navigator.deviceMemory + ' GB+' : '?'],
    ['Multi-core', self.crossOriginIsolated ? 'yes' : 'no (reload once if this stays no)'],
    ['GPU (WebGPU)', g],
  ];
  $('#dev').innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  const cores = navigator.hardwareConcurrency || 4;
  $('#threads').innerHTML = [1, 2, 4, 6, 8].filter(n => n <= Math.max(cores, 1)).map(n => `<option${n === Math.min(4, cores) ? ' selected' : ''}>${n}</option>`).join('');
  const pick = store.get('lab.pick', 'q8-cpu');
  $('#cands').innerHTML = CANDS.map(c => {
    const off = c.ep === 'webgpu' && (!gpu || (c.f16 && !gpu.f16));
    return `<label class="cand${off ? ' off' : ''}"><input type="radio" name="c" value="${c.id}"${off ? ' disabled' : ''}${c.id === pick && !off ? ' checked' : ''}>
      <span><span class="n">${c.name}</span><br><span class="m">${c.mb} MB download${off ? ' · not supported on this phone' : ''}</span></span></label>`;
  }).join('');
  if (!document.querySelector('input[name=c]:checked')) document.querySelector('input[name=c]:not(:disabled)')?.click();

  AYAT = await (await fetch('ayat.json')).json();
  $('#reciter').innerHTML = RECITERS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('') + '<option value="*">All 12 reciters</option>';
  $('#set').innerHTML = SETS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  $('#liveAya').innerHTML = AYAT.map((x, i) => `<option value="${i}">${x.name} ${x.a}</option>`).join('');
  if (!SETS.some(x => x[0] === store.get('lab.set', 'quick'))) store.set('lab.set', 'quick');
  $('#reciter').value = store.get('lab.reciter', 'Husary_64kbps');
  $('#set').value = store.get('lab.set', 'quick');
  $('#sound').checked = store.get('lab.sound', true);
  $('#showSnd').checked = store.get('lab.showSnd', false);
  $('#snd').hidden = !$('#showSnd').checked;
  showAya(AYAT[0], null);
  paintResults();
}

// ---- the audio ring shared with the worker (when the page is isolated)
const now = () => performance.timeOrigin + performance.now();
let shared = null;
function newRing() {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return null;
  return { ring: new Float32Array(new SharedArrayBuffer(4 * RATE * 30)), meta: new Int32Array(new SharedArrayBuffer(4)), time: new Float64Array(new SharedArrayBuffer(8)) };
}
// ---- finding the fastest candidate on this phone, before downloading anything
const PROBE_X = 12; // a full update ≈ this many times the probe (two of 24 layers, plus the rest)
function probePhone() {
  const list = CANDS.filter(c => !(c.ep === 'webgpu' && (!gpu || (c.f16 && !gpu.f16))));
  const out = $('#probeOut'), res = {};
  out.innerHTML = list.map(c => `<div id="pr-${c.id}"><span>${c.name} <span class="note">· ${c.mb} MB</span></span><b>…</b><span class="barp"><i style="width:0"></i></span></div>`).join('')
    + CANDS.filter(c => !list.includes(c)).map(c => `<div class="na"><span>${c.name}</span><span>not on this phone</span></div>`).join('');
  $('#probe').disabled = true; $('#pickRow').hidden = true;
  const w = new Worker('worker.js', { type: 'module' });
  w.onmessage = ({ data: d }) => {
    if (d.type === 'probed') {
      res[d.id] = d;
      const row = $('#pr-' + d.id);
      row.querySelector('b').textContent = d.error ? 'failed' : `≈ ${Math.round(d.ms * PROBE_X)} ms per update`;
      if (d.error) row.classList.add('na'), row.title = d.error;
    }
    if (d.type === 'probedAll') {
      w.terminate();
      $('#probe').disabled = false; $('#probe').textContent = 'Test again';
      const ok = list.filter(c => res[c.id] && !res[c.id].error);
      if (!ok.length) return;
      const fastest = Math.min(...ok.map(c => res[c.id].ms));
      ok.forEach(c => { $('#pr-' + c.id + ' .barp i').style.width = (fastest / res[c.id].ms * 100).toFixed(0) + '%'; });
      // the fastest; within 10% of it, the smaller download
      const best = ok.filter(c => res[c.id].ms <= fastest * 1.1).sort((a, b) => a.mb - b.mb || res[a.id].ms - res[b.id].ms)[0];
      $('#pr-' + best.id).classList.add('best');
      store.set('lab.best', { id: best.id, at: Date.now(), ms: res[best.id].ms * PROBE_X });
      $('#getBest').textContent = `Download ${best.name} (${best.mb} MB)`;
      $('#getBest').onclick = () => { document.querySelector(`input[value="${best.id}"]`).click(); load(); $('#lstatus').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      $('#pickRow').hidden = false;
    }
  };
  w.postMessage({ type: 'probe', list: list.map(({ id, variant, ep }) => ({ id, variant, ep })), threads: +$('#threads').value });
}

// ---- loading a candidate
let worker = null, cur = null, ready = false, loadMs = 0;
function load() {
  const c = CANDS.find(x => x.id === document.querySelector('input[name=c]:checked')?.value);
  if (!c) return;
  store.set('lab.pick', c.id);
  worker?.terminate();
  ready = false; cur = c;
  $('#bench').disabled = $('#mic').disabled = true;
  $('#bar').style.width = '0';
  status('#lstatus', `Loading ${c.name}…`);
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = ({ data: d }) => {
    if (d.type === 'progress') {
      $('#bar').style.width = (d.loaded / d.total * 100).toFixed(1) + '%';
      if (d.net) status('#lstatus', `Downloading ${c.name}: ${(d.loaded / 1e6).toFixed(0)} / ${(d.total / 1e6).toFixed(0)} MB`);
    }
    if (d.type === 'ready') {
      ready = true; loadMs = d.loadMs;
      $('#bar').style.width = '100%';
      status('#lstatus', `${c.name} ready · ${d.fromCache ? 'from this phone' : 'downloaded'} · started in ${(d.loadMs / 1000).toFixed(1)} s · ${d.ep === 'wasm' ? d.threads + ' CPU threads' : 'GPU'}`);
      $('#bench').disabled = $('#mic').disabled = false;
    }
    if (d.type === 'text') onText(d);
    if (d.type === 'flushed') onFlushed?.();
    if (d.type === 'error') { status(ready ? '#tstatus' : '#lstatus', 'Error: ' + d.message, true); if (!ready) worker.terminate(); }
  };
  worker.onerror = e => status('#lstatus', 'Error: ' + (e.message || 'worker failed'), true);
  shared = newRing();
  worker.postMessage({ type: 'load', variant: c.variant, ep: c.ep, threads: +$('#threads').value, shared });
}
function status(sel, t, err) { const el = $(sel); el.textContent = t; el.classList.toggle('err', !!err); }

// ---- the aya on screen, word by word
let shown = null; // { aya, states }
function showAya(aya, states, who) {
  shown = { aya, states };
  $('#refL').textContent = who || '';
  $('#refR').textContent = `${aya.name} ${ar(aya.a)}`;
  $('#aya').innerHTML = aya.words.map((w, i) => {
    const s = states?.[i];
    const st = s ? s.state : 'todo';
    const tip = s?.state === 'err' ? ` title="${s.type}: heard ${s.heard || '—'}"` : '';
    return `<span class="w ${st}"${tip}>${w}</span>`;
  }).join(' ');
  $('#sndE').textContent = aya.ph;
}
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// ---- sound: one AudioContext, made on the first tap (phones only allow
// starting sound from a tap) and kept; capture runs on the audio thread
let actx = null, tapReady = null;
function sound() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    tapReady = actx.audioWorklet.addModule('capture.js');
  }
  actx.resume();
  return tapReady;
}
// a node that hands whatever is connected to it to the model
function tap() {
  const clock0 = now() - actx.currentTime * 1000;
  const node = new AudioWorkletNode(actx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { shared, clock0 } });
  if (!shared) node.port.onmessage = e => worker.postMessage({ type: 'audio', samples: e.data.samples, at: e.data.at });
  node.connect(actx.destination); // silent: it writes nothing to its output
  return node;
}
const fetchAudio = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url.split('/').pop()}: HTTP ${r.status}`); return r.arrayBuffer(); }).then(b => actx.decodeAudioData(b));

// ---- live text: model output -> aya words
let run = null, onFlushed = null;
function onText(d) {
  if (!run) return;
  run.ms.push(d.ms); run.lag.push(d.lag);
  run.final = d.final; run.tent = d.tent;
  $('#sMs').textContent = Math.round(avg(run.ms));
  $('#sLag').textContent = Math.round(avg(run.lag));
  if (run.seq) follow();
  else showAya(run.aya, Match.words(run.aya, d.final + d.tent, d.final.length), run.who);
  $('#sndH').innerHTML = esc(run.final) + `<span class="t">${esc(run.tent)}</span>`;
}
const flush = () => new Promise(r => { onFlushed = r; worker.postMessage({ type: 'flush' }); });
// the aya is over: every word decided
function verdict() {
  const states = Match.words(run.aya, run.final, run.final.length, true);
  showAya(run.aya, states, run.who);
  return states;
}

// ---- following a reciter through consecutive ayat: what was heard is matched
// against the current aya and the next one together; once the next one has
// begun, the current one is closed (words never reached count as skipped) and
// what was heard for it is set aside
const pairs = new Map();
function pair(a, b) {
  const k = `${a.s}:${a.a}`;
  if (!pairs.has(k)) pairs.set(k, { ph: a.ph + b.ph, words: a.words.concat(b.words), spans: a.spans.concat(b.spans.map(([x, y]) => [x + a.ph.length, y + a.ph.length])) });
  return pairs.get(k);
}
function follow(done) {
  const U = Match.units(run.final + run.tent), uf = Match.units(run.final).length;
  for (;;) {
    const cur = run.seq[run.c], next = done ? null : run.seq[run.c + 1], n0 = cur.words.length;
    const sub = Match.text(U.slice(run.cut)), fin = Match.text(U.slice(run.cut, Math.max(run.cut, uf))).length;
    const st = Match.words(next ? pair(cur, next) : cur, sub, fin, !!done);
    const begun = next && st.slice(n0, n0 + 2).some(x => x.state === 'ok' || x.state === 'err');
    if (!begun) { showAya(cur, st.slice(0, n0), run.who); return st.slice(0, n0); }
    closeAya(cur, st.slice(0, n0).map(x => x.state === 'ok' || x.state === 'err' ? x : { state: 'err', type: 'skipped' }));
    run.cut += st[n0].at[0];
    run.c++;
  }
}
function closeAya(aya, states) {
  const ok = states.filter(x => x.state === 'ok').length;
  run.right += ok; run.words += states.length;
  const wrong = states.map((x, i) => x.state === 'err' ? aya.words[i] : null).filter(Boolean);
  $('#log').insertAdjacentHTML('afterbegin', `<div><span class="k">${aya.s}:${aya.a}</span><span>${ok}/${states.length}</span>${wrong.length ? `<span class="bad">${wrong.join(' · ')}</span>` : ''}</div>`);
  $('#sAcc').textContent = (run.right / run.words * 100).toFixed(0) + '%';
}

// ---- benchmark: each aya played (aloud, if Sound is on) and fed to the model as it plays
let stopping = false, stopper = null;
async function playAndFeed(buf, aya, who) {
  run = { aya, who, ms: run?.ms || [], lag: run?.lag || [], final: '', tent: '' };
  showAya(aya, null, who);
  $('#sndH').textContent = '';
  worker.postMessage({ type: 'start' });
  const src = actx.createBufferSource(); src.buffer = buf;
  const vol = actx.createGain(); vol.gain.value = $('#sound').checked ? 1 : 0;
  const node = tap();
  src.connect(vol).connect(actx.destination);
  src.connect(node);
  await new Promise(r => { src.onended = r; src.start(); stopper = () => { try { src.stop(); } catch {} }; });
  stopper = null;
  await new Promise(r => setTimeout(r, 150)); // the last block through the audio thread
  node.port.postMessage('stop'); node.disconnect(); src.disconnect(); vol.disconnect();
  await flush();
  return verdict();
}
async function bench() {
  const ready = sound(); // inside the tap
  const rec = $('#reciter').value, set = SETS.find(x => x[0] === $('#set').value);
  store.set('lab.reciter', rec); store.set('lab.set', set[0]); store.set('lab.sound', $('#sound').checked);
  const list = (set[2] || AYAT.map(x => [x.s, x.a])).map(([s, a]) => AYAT.find(x => x.s === s && x.a === a));
  const reciters = rec === '*' ? RECITERS : RECITERS.filter(r => r[0] === rec);
  const jobs = reciters.flatMap(([folder, who]) => list.map(aya => ({ folder, who, aya })));
  const pad = n => String(n).padStart(3, '0');
  const url = j => `https://everyayah.com/data/${j.folder}/${pad(j.aya.s)}${pad(j.aya.a)}.mp3`;
  $('#bench').disabled = $('#mic').disabled = true; $('#stopb').hidden = false; stopping = false;
  $('#log').innerHTML = '';
  run = null;
  let words = 0, right = 0;
  const bad = [];
  try {
    await ready;
    let nextBuf = fetchAudio(url(jobs[0]));
    for (let k = 0; k < jobs.length && !stopping; k++) {
      const j = jobs[k];
      status('#tstatus', `${j.who} · ${j.aya.name} ${j.aya.a} (${k + 1}/${jobs.length})`);
      const buf = await nextBuf;
      if (k + 1 < jobs.length) nextBuf = fetchAudio(url(jobs[k + 1])); // the next one loads while this one plays
      const states = await playAndFeed(buf, j.aya, j.who);
      const ok = states.filter(x => x.state === 'ok').length;
      words += states.length; right += ok;
      const wrong = states.map((x, i) => x.state === 'err' ? j.aya.words[i] : null).filter(Boolean);
      wrong.forEach(w => bad.push(`${j.who}: ${j.aya.s}:${j.aya.a} ${w}`));
      $('#log').insertAdjacentHTML('afterbegin', `<div><span class="k">${j.who.split(' ').pop()} ${j.aya.s}:${j.aya.a}</span><span>${ok}/${states.length}</span>${wrong.length ? `<span class="bad">${wrong.join(' · ')}</span>` : ''}</div>`);
      $('#sAcc').textContent = (right / words * 100).toFixed(1) + '%';
    }
    if (words) {
      status('#tstatus', `${stopping ? 'Stopped' : 'Done'}: ${right}/${words} words right. Saved below.`);
      save({ test: `${reciters.length > 1 ? 'all reciters' : reciters[0][1]} · ${set[1].split(' ·')[0]}`, ms: avg(run.ms), worst: Math.max(...run.ms), lag: avg(run.lag), acc: right / words * 100, words, bad });
    }
  } catch (e) { status('#tstatus', 'Error: ' + e.message, true); }
  run = null;
  $('#bench').disabled = $('#mic').disabled = false; $('#stopb').hidden = true;
}

// ---- recite live: from the chosen aya on through its surah, aya after aya
let mic = null;
async function toggleMic() {
  if (mic) return stopMic();
  const ready = sound(); // inside the tap
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await ready;
    const start = AYAT[+$('#liveAya').value], seq = AYAT.filter(x => x.s === start.s && x.a >= start.a);
    run = { seq, c: 0, cut: 0, who: 'You', ms: [], lag: [], final: '', tent: '', right: 0, words: 0 };
    showAya(seq[0], null, 'You');
    $('#sndH').textContent = ''; $('#log').innerHTML = ''; $('#sAcc').textContent = '–';
    worker.postMessage({ type: 'start' });
    const src = actx.createMediaStreamSource(stream), node = tap();
    src.connect(node);
    mic = { stream, src, node };
    $('#mic').textContent = 'Stop';
    $('#bench').disabled = true;
    status('#tstatus', `Listening… recite from ${start.name} ${start.a}; it moves on as you do.`);
  } catch (e) { status('#tstatus', 'Microphone: ' + e.message, true); }
}
async function stopMic() {
  const m = mic; mic = null;
  m.node.port.postMessage('stop'); m.src.disconnect(); m.node.disconnect(); m.stream.getTracks().forEach(t => t.stop());
  $('#mic').textContent = 'Recite live';
  status('#tstatus', 'Finishing…');
  await flush();
  const last = run.seq[run.c], st = follow(true);
  if (st.some(x => x.state !== 'todo')) closeAya(last, st);
  if (run.ms.length) save({ test: `you · ${run.seq[0].name} ${run.seq[0].a}–${last.a}`, ms: avg(run.ms), worst: Math.max(...run.ms), lag: avg(run.lag), acc: run.words ? run.right / run.words * 100 : null, live: true, words: run.words });
  status('#tstatus', `Stopped: ${run.right}/${run.words} words right over ${run.c + 1} ayat. Speed saved below.`);
  run = null;
  $('#bench').disabled = false;
}

// ---- results
function save(r) {
  const all = store.get('lab.results', []);
  all.push({ id: cur.id, name: cur.name, threads: cur.ep === 'wasm' ? +$('#threads').value : null, load: loadMs, ...r, at: Date.now() });
  store.set('lab.results', all);
  paintResults();
}
function paintResults() {
  const all = store.get('lab.results', []);
  const bench = all.filter(r => !r.live), best = k => Math.min(...bench.map(r => r[k]));
  $('#res').innerHTML = all.map(r => `<tr><td>${r.name}${r.threads ? ` (${r.threads}t)` : ''}</td><td>${r.test || ''}</td>
    <td class="${!r.live && r.ms === best('ms') ? 'best' : ''}">${Math.round(r.ms)}ms</td>
    <td class="${!r.live && r.lag === best('lag') ? 'best' : ''}">${Math.round(r.lag)}ms</td>
    <td>${r.acc == null ? '–' : r.acc.toFixed(1) + '%'}</td></tr>`).join('') || '<tr><td colspan="5" class="note">Nothing yet.</td></tr>';
}
function copy() {
  const all = store.get('lab.results', []);
  const text = [`Muaalem lab · ${navigator.userAgent}`, `cores ${navigator.hardwareConcurrency}, isolated ${self.crossOriginIsolated}, webgpu ${gpu ? 'yes' + (gpu.f16 ? ' f16' : '') : 'no'}`,
    ...all.map(r => `${r.name}${r.threads ? ` ${r.threads}t` : ''} · ${r.test || ''}: load ${(r.load / 1000).toFixed(1)}s, update ${Math.round(r.ms)}ms (worst ${Math.round(r.worst)}), behind ${Math.round(r.lag)}ms, words right ${r.acc == null ? '-' : r.acc.toFixed(1) + '% of ' + r.words}${r.bad?.length ? ' · flagged: ' + r.bad.join(', ') : ''}`)].join('\n');
  navigator.clipboard.writeText(text).then(() => status('#tstatus', 'Results copied.'), () => { $('#log').textContent = text; status('#tstatus', 'Copy failed: the results are in the box above.'); });
}

$('#load').onclick = load;
$('#probe').onclick = probePhone;
$('#bench').onclick = bench;
$('#stopb').onclick = () => { stopping = true; stopper?.(); };
$('#mic').onclick = toggleMic;
$('#copy').onclick = copy;
$('#reset').onclick = () => { store.set('lab.results', []); paintResults(); };
$('#clear').onclick = async () => { await caches.delete('muaalem-lab'); status('#lstatus', 'Downloads deleted.'); };
$('#showSnd').onchange = () => { $('#snd').hidden = !$('#showSnd').checked; store.set('lab.showSnd', $('#showSnd').checked); };
$('#liveAya').onchange = () => { if (!run) showAya(AYAT[+$('#liveAya').value], null); };
device();
