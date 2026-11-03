'use strict';

// The candidates: one model file (8-bit, 4-bit or fp16) on one backend.
const CANDS = [
  { id: 'q8-cpu', variant: 'q8', ep: 'wasm', name: '8-bit · CPU', mb: 126 },
  { id: 'q8-gpu', variant: 'q8', ep: 'webgpu', name: '8-bit · GPU', mb: 126 },
  { id: 'fp16-gpu', variant: 'fp16', ep: 'webgpu', name: 'fp16 · GPU', mb: 234, f16: true },
  { id: 'q4-cpu', variant: 'q4', ep: 'wasm', name: '4-bit · CPU', mb: 86 },
  { id: 'q4-gpu', variant: 'q4', ep: 'webgpu', name: '4-bit · GPU', mb: 86 },
];
// what the full-precision model reads in Husary's recitation (2.5 s windows)
const SAMPLES = [
  { url: 'https://everyayah.com/data/Husary_64kbps/067001.mp3', ref: 'تَبَاارَكَللَذِۦۦبِيَدِهِلمُلكُوَهُوَعَلَااكُللِشَيءِںںںقَدِۦۦۦۦر' },
  { url: 'https://everyayah.com/data/Husary_64kbps/001002.mp3', ref: 'ءَلحَمدُلِللَااهِرَببِلعَاالَمِۦۦۦۦن' },
];
const RATE = 16000, CHUNK = 1024;
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---- cross-origin isolation (several cores) through sw.js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => {
    if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
      sessionStorage.setItem('coi-reloaded', '1');
      navigator.serviceWorker.ready.then(() => location.reload());
    }
  });
}

// ---- the device
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
      status('#lstatus', `Downloading ${c.name}: ${(d.loaded / 1e6).toFixed(0)} / ${(d.total / 1e6).toFixed(0)} MB`);
    }
    if (d.type === 'ready') {
      ready = true; loadMs = d.loadMs;
      $('#bar').style.width = '100%';
      status('#lstatus', `${c.name} ready · started in ${(d.loadMs / 1000).toFixed(1)} s · ${d.ep === 'wasm' ? d.threads + ' CPU threads' : 'GPU'}`);
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

// ---- live text and timing
let run = null, onFlushed = null;
function onText(d) {
  if (!run) return;
  run.ms.push(d.ms); run.lag.push(d.lag); run.text = d.final + d.tent;
  $('#out').innerHTML = esc(run.prefix + d.final) + `<span class="t">${esc(d.tent)}</span>`;
  $('#sMs').textContent = Math.round(avg(run.ms));
  $('#sLag').textContent = Math.round(avg(run.lag));
}
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
function sim(a, b) { // 1 - edit distance / length
  const m = a.length, n = b.length;
  let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const q = [i];
    for (let j = 1; j <= n; j++) q[j] = Math.min(p[j] + 1, q[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = q;
  }
  return 1 - p[n] / Math.max(m, n, 1);
}
const flush = () => new Promise(r => { onFlushed = r; worker.postMessage({ type: 'flush' }); });

// ---- benchmark: Husary's recordings fed in real time, 64 ms at a time
async function decode(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const a = await ctx.decodeAudioData(buf);
  return a.getChannelData(0);
}
async function bench() {
  $('#bench').disabled = $('#mic').disabled = true;
  run = { ms: [], lag: [], text: '', prefix: '' };
  const scores = [];
  try {
    for (const s of SAMPLES) {
      status('#tstatus', 'Fetching ' + s.url.split('/').pop() + '…');
      const a = await decode(s.url);
      worker.postMessage({ type: 'start' });
      status('#tstatus', 'Reading in real time…');
      const t0 = performance.now();
      for (let i = 0; i < a.length; i += CHUNK) {
        const wait = t0 + ((i + CHUNK) / RATE) * 1000 - performance.now(); // as a microphone would deliver it
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        push(a.slice(i, i + CHUNK));
      }
      await flush();
      scores.push(sim(run.text, s.ref));
      run.prefix += run.text + ' · ';
    }
    const acc = avg(scores) * 100;
    $('#sAcc').textContent = acc.toFixed(1) + '%';
    status('#tstatus', 'Done. Saved to the results below.');
    save({ ms: avg(run.ms), worst: Math.max(...run.ms), lag: avg(run.lag), acc });
  } catch (e) { status('#tstatus', 'Error: ' + e.message, true); }
  run = null;
  $('#bench').disabled = $('#mic').disabled = false;
}

// ---- recite live
let mic = null;
async function toggleMic() {
  if (mic) return stopMic();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const src = ctx.createMediaStreamSource(stream), node = ctx.createScriptProcessor(CHUNK, 1, 1), step = ctx.sampleRate / RATE;
    node.onaudioprocess = e => {
      const x = e.inputBuffer.getChannelData(0);
      let y;
      if (step === 1) y = new Float32Array(x);
      else {
        y = new Float32Array(Math.floor(x.length / step));
        for (let i = 0; i < y.length; i++) { const p = i * step, k = Math.floor(p), f = p - k; y[i] = x[k] * (1 - f) + (x[k + 1] ?? x[k]) * f; }
      }
      push(y);
    };
    src.connect(node); node.connect(ctx.destination);
    mic = { ctx, stream, node, src };
    worker.postMessage({ type: 'start' });
    run = { ms: [], lag: [], text: '', prefix: '' };
    $('#out').textContent = '';
    $('#sAcc').textContent = '–';
    $('#mic').textContent = 'Stop';
    $('#bench').disabled = true;
    status('#tstatus', `Listening (${ctx.sampleRate} Hz)… recite.`);
  } catch (e) { status('#tstatus', 'Microphone: ' + e.message, true); }
}
async function stopMic() {
  const m = mic; mic = null;
  m.node.disconnect(); m.src.disconnect(); m.stream.getTracks().forEach(t => t.stop()); m.ctx.close();
  $('#mic').textContent = 'Recite live';
  status('#tstatus', 'Finishing…');
  await flush();
  if (run?.ms.length) save({ ms: avg(run.ms), worst: Math.max(...run.ms), lag: avg(run.lag), acc: null, live: true });
  run = null;
  $('#bench').disabled = false;
  status('#tstatus', 'Stopped. Speed saved to the results below.');
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
  $('#res').innerHTML = all.map(r => `<tr><td>${r.name}${r.threads ? ` (${r.threads}t)` : ''}${r.live ? ' · live' : ''}</td>
    <td>${(r.load / 1000).toFixed(1)}s</td>
    <td class="${!r.live && r.ms === best('ms') ? 'best' : ''}">${Math.round(r.ms)}ms</td>
    <td class="${!r.live && r.lag === best('lag') ? 'best' : ''}">${Math.round(r.lag)}ms</td>
    <td>${r.acc == null ? '–' : r.acc.toFixed(1) + '%'}</td></tr>`).join('') || '<tr><td colspan="5" class="note">Nothing yet.</td></tr>';
}
function copy() {
  const all = store.get('lab.results', []);
  const text = [`Muaalem lab · ${navigator.userAgent}`, `cores ${navigator.hardwareConcurrency}, isolated ${self.crossOriginIsolated}, webgpu ${gpu ? 'yes' + (gpu.f16 ? ' f16' : '') : 'no'}`,
    ...all.map(r => `${r.name}${r.threads ? ` ${r.threads}t` : ''}${r.live ? ' live' : ''}: load ${(r.load / 1000).toFixed(1)}s, update ${Math.round(r.ms)}ms (worst ${Math.round(r.worst)}), behind ${Math.round(r.lag)}ms, match ${r.acc == null ? '-' : r.acc.toFixed(1) + '%'}`)].join('\n');
  navigator.clipboard.writeText(text).then(() => status('#tstatus', 'Results copied.'), () => { $('#out').textContent = text; status('#tstatus', 'Copy failed: the results are in the box above.'); });
}

$('#load').onclick = load;
$('#bench').onclick = bench;
$('#mic').onclick = toggleMic;
$('#copy').onclick = copy;
$('#reset').onclick = () => { store.set('lab.results', []); paintResults(); };
$('#clear').onclick = async () => { await caches.delete('muaalem-lab'); status('#lstatus', 'Downloads deleted.'); };
device();
