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
const SETS = [
  ['quick', 'Quick · 6 ayat', [[1, 2], [1, 7], [112, 1], [103, 2], [67, 1], [55, 3]]],
  ['all', 'All 19 ayat (incl. Ayat al-Kursi)', null],
  ['short', 'Short surahs · 7 ayat', [[112, 1], [112, 2], [112, 3], [112, 4], [103, 1], [103, 2], [103, 3]]],
  ['mulk', 'Al-Mulk 1–3 + Ar-Rahman 1–4', [[67, 1], [67, 2], [67, 3], [55, 1], [55, 2], [55, 3], [55, 4]]],
  ['kursi', 'Ayat al-Kursi', [[2, 255]]],
];
const RATE = 16000, CHUNK = 1024;
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
// hand samples (16 kHz) to the worker
function push(y) {
  if (!shared) { worker.postMessage({ type: 'audio', samples: y, at: now() }); return; }
  const { ring, meta, time } = shared, w = Atomics.load(meta, 0), R = ring.length;
  for (let i = 0; i < y.length; i++) ring[(w + i) % R] = y[i];
  time[0] = now();
  Atomics.store(meta, 0, w + y.length);
}
// a ScriptProcessor's block, copied and brought to 16 kHz
function to16k(x, rate) {
  const step = rate / RATE;
  if (step === 1) return new Float32Array(x);
  const y = new Float32Array(Math.floor(x.length / step));
  for (let i = 0; i < y.length; i++) { const p = i * step, k = Math.floor(p), f = p - k; y[i] = x[k] * (1 - f) + (x[k + 1] ?? x[k]) * f; }
  return y;
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

// ---- live text: model output -> aya words
let run = null, onFlushed = null;
function onText(d) {
  if (!run) return;
  run.ms.push(d.ms); run.lag.push(d.lag);
  run.final = d.final; run.tent = d.tent;
  const states = Match.words(run.aya, d.final + d.tent, d.final.length);
  showAya(run.aya, states, run.who);
  $('#sndH').innerHTML = esc(d.final) + `<span class="t">${esc(d.tent)}</span>`;
  $('#sMs').textContent = Math.round(avg(run.ms));
  $('#sLag').textContent = Math.round(avg(run.lag));
}
const flush = () => new Promise(r => { onFlushed = r; worker.postMessage({ type: 'flush' }); });
// the aya is over: every word decided
function verdict() {
  const states = Match.words(run.aya, run.final, run.final.length, true);
  showAya(run.aya, states, run.who);
  return states;
}

// ---- benchmark: each aya played (aloud, if Sound is on) and fed to the model as it plays
let stopping = false;
async function playAndFeed(url, aya, who) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    run = { aya, who, ms: run?.ms || [], lag: run?.lag || [], final: '', tent: '' };
    showAya(aya, null, who);
    $('#sndH').textContent = '';
    worker.postMessage({ type: 'start' });
    const src = ctx.createBufferSource(); src.buffer = buf;
    const vol = ctx.createGain(); vol.gain.value = $('#sound').checked ? 1 : 0;
    const node = ctx.createScriptProcessor(4096 >> (ctx.sampleRate > 24000 ? 1 : 2), 1, 1);
    node.onaudioprocess = e => push(to16k(e.inputBuffer.getChannelData(0), ctx.sampleRate));
    src.connect(vol).connect(ctx.destination);
    src.connect(node).connect(ctx.destination);
    await ctx.resume();
    await new Promise(r => { src.onended = r; src.start(); stopper = () => { try { src.stop(); } catch {} }; });
    await new Promise(r => setTimeout(r, 200)); // the processor's last block
    node.disconnect();
  } finally { ctx.close(); stopper = null; }
  await flush();
  return verdict();
}
let stopper = null;
async function bench() {
  const rec = $('#reciter').value, set = SETS.find(s => s[0] === $('#set').value);
  store.set('lab.reciter', rec); store.set('lab.set', set[0]); store.set('lab.sound', $('#sound').checked);
  const list = (set[2] || AYAT.map(x => [x.s, x.a])).map(([s, a]) => AYAT.find(x => x.s === s && x.a === a));
  const reciters = rec === '*' ? RECITERS : RECITERS.filter(r => r[0] === rec);
  $('#bench').disabled = $('#mic').disabled = true; $('#stopb').hidden = false; stopping = false;
  $('#log').innerHTML = '';
  run = null;
  let words = 0, right = 0;
  const bad = [];
  try {
    for (const [folder, who] of reciters) {
      for (const aya of list) {
        if (stopping) break;
        const pad = n => String(n).padStart(3, '0');
        status('#tstatus', `${who} · ${aya.name} ${aya.a}`);
        const states = await playAndFeed(`https://everyayah.com/data/${folder}/${pad(aya.s)}${pad(aya.a)}.mp3`, aya, who);
        const ok = states.filter(s => s.state === 'ok').length;
        words += states.length; right += ok;
        const wrong = states.map((s, i) => s.state === 'err' ? aya.words[i] : null).filter(Boolean);
        wrong.forEach(w => bad.push(`${who}: ${aya.s}:${aya.a} ${w}`));
        $('#log').insertAdjacentHTML('afterbegin', `<div><span class="k">${who.split(' ').pop()} ${aya.s}:${aya.a}</span><span>${ok}/${states.length}</span>${wrong.length ? `<span class="bad">${wrong.join(' · ')}</span>` : ''}</div>`);
        $('#sAcc').textContent = (right / words * 100).toFixed(1) + '%';
      }
    }
    if (words) {
      status('#tstatus', `${stopping ? 'Stopped' : 'Done'}: ${right}/${words} words right. Saved below.`);
      save({ test: `${reciters.length > 1 ? 'all reciters' : reciters[0][1]} · ${set[1].split(' ·')[0]}`, ms: avg(run.ms), worst: Math.max(...run.ms), lag: avg(run.lag), acc: right / words * 100, words, bad });
    }
  } catch (e) { status('#tstatus', 'Error: ' + e.message, true); }
  run = null;
  $('#bench').disabled = $('#mic').disabled = false; $('#stopb').hidden = true;
}

// ---- recite live: the chosen aya lights up as you recite it
let mic = null;
async function toggleMic() {
  if (mic) return stopMic();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const src = ctx.createMediaStreamSource(stream), node = ctx.createScriptProcessor(CHUNK, 1, 1);
    node.onaudioprocess = e => push(to16k(e.inputBuffer.getChannelData(0), ctx.sampleRate));
    src.connect(node); node.connect(ctx.destination);
    mic = { ctx, stream, node, src };
    const aya = AYAT[+$('#liveAya').value];
    run = { aya, who: 'You', ms: [], lag: [], final: '', tent: '' };
    showAya(aya, null, 'You');
    $('#sndH').textContent = '';
    worker.postMessage({ type: 'start' });
    $('#mic').textContent = 'Stop';
    $('#bench').disabled = true;
    status('#tstatus', `Listening… recite ${aya.name} ${aya.a}.`);
  } catch (e) { status('#tstatus', 'Microphone: ' + e.message, true); }
}
async function stopMic() {
  const m = mic; mic = null;
  m.node.disconnect(); m.src.disconnect(); m.stream.getTracks().forEach(t => t.stop()); m.ctx.close();
  $('#mic').textContent = 'Recite live';
  status('#tstatus', 'Finishing…');
  await flush();
  const states = verdict();
  const ok = states.filter(s => s.state === 'ok').length;
  if (run?.ms.length) save({ test: `you · ${run.aya.name} ${run.aya.a}`, ms: avg(run.ms), worst: Math.max(...run.ms), lag: avg(run.lag), acc: null, live: true });
  status('#tstatus', `Stopped: ${ok}/${states.length} words right. Speed saved below.`);
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
$('#bench').onclick = bench;
$('#stopb').onclick = () => { stopping = true; stopper?.(); };
$('#mic').onclick = toggleMic;
$('#copy').onclick = copy;
$('#reset').onclick = () => { store.set('lab.results', []); paintResults(); };
$('#clear').onclick = async () => { await caches.delete('muaalem-lab'); status('#lstatus', 'Downloads deleted.'); };
$('#showSnd').onchange = () => { $('#snd').hidden = !$('#showSnd').checked; store.set('lab.showSnd', $('#showSnd').checked); };
$('#liveAya').onchange = () => { if (!run) showAya(AYAT[+$('#liveAya').value], null); };
device();
