// Runs one Muaalem candidate (model file + backend) and reads recitation as it
// grows: whenever at least MIN_NEW s of new audio has come in, the last WIN s
// are read again; output frames with RIGHT s of audio after them are final,
// the rest is shown as tentative.
//
// The page writes the microphone into a ring shared with this worker
// (SharedArrayBuffer), so each read takes everything heard up to that moment;
// without isolation it falls back to messages.
//
// in:  load {variant, ep, threads, shared: {ring, meta, time}} · start · audio {samples} · flush
// out: progress {loaded, total} · ready {loadMs, ep, threads} · text {final, tent, ms, lag} · flushed · error {message}

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const TJS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
const BASE = new URL('../', location.href).href; // the repo root
const WIN = 2.5, RIGHT = 0.5, MIN_NEW = 0.25, RATE = 16000;
const now = () => performance.timeOrigin + performance.now(); // same clock as the page

let ort, fe, vocab, session;
// the ring: meta[0] = samples written so far, time[0] = when the last ones came in
let ring = new Float32Array(RATE * 30), meta = new Int32Array(1), time = new Float64Array(1);
let base = 0;                                      // samples written before this recitation
let kept = [], keptUntil = 0, readUpTo = 0;        // frames made final, and up to when (s)
let live = false, looping = null;

async function fetchParts(variant) {
  const man = await (await fetch(BASE + 'muaalem/manifest.json', { cache: 'no-cache' })).json();
  const v = man.variants[variant];
  const cache = await caches.open('muaalem-lab');
  const out = new Uint8Array(v.bytes);
  let at = 0, loaded = 0;
  for (const p of v.parts) {
    const url = BASE + p.path + '?h=' + p.sha256.slice(0, 12);
    let res = await cache.match(url);
    if (!res) {
      const net = await fetch(url);
      if (!net.ok) throw new Error(`${p.path}: HTTP ${net.status}`);
      const reader = net.body.getReader(), chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        postMessage({ type: 'progress', loaded: loaded + got, total: v.bytes });
      }
      const blob = new Blob(chunks);
      await cache.put(url, new Response(blob));
      res = new Response(blob);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    out.set(buf, at); at += buf.length; loaded += buf.length;
    postMessage({ type: 'progress', loaded, total: v.bytes });
  }
  return out;
}

async function load({ variant, ep, threads, shared }) {
  if (shared) ({ ring, meta, time } = shared);
  const t0 = performance.now();
  ort = await import(ORT + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? threads : 1;
  const { AutoFeatureExtractor, env } = await import(TJS);
  env.allowLocalModels = true; env.allowRemoteModels = false; env.localModelPath = BASE;
  fe = await AutoFeatureExtractor.from_pretrained('muaalem');
  vocab = (await (await fetch(BASE + 'muaalem/phoneme_vocab.json')).json()).id_to_char;
  const bytes = await fetchParts(variant);
  const t1 = performance.now();
  session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
  await ids(new Float32Array(RATE * WIN)); // warm up (shader compilation on the GPU)
  postMessage({ type: 'ready', loadMs: performance.now() - t1, totalMs: performance.now() - t0, ep, threads: ort.env.wasm.numThreads });
}

async function ids(x) {
  const f = (await fe(x)).input_features;
  const lg = (await session.run({ input_features: new ort.Tensor('float32', f.data, f.dims) })).logits;
  const d = await lg.getData(), [, T, V] = lg.dims, o = new Int32Array(T);
  for (let t = 0; t < T; t++) {
    let b = 0;
    for (let v = 1; v < V; v++) if (d[t * V + v] > d[t * V + b]) b = v;
    o[t] = b;
  }
  return o;
}

function decode(list) {
  let out = '', prev = -1;
  for (const b of list) { if (b !== prev && b !== 0) out += vocab[b]; prev = b; }
  return out;
}

const written = () => Atomics.load(meta, 0);

// samples [from, to) of the recitation, out of the ring
function slice(from, to) {
  const out = new Float32Array(to - from), R = ring.length;
  for (let i = from; i < to; i++) out[i - from] = ring[(base + i) % R];
  return out;
}

// read the newest window; final reads to the very end (the reader stopped)
async function step(final) {
  const n = written() - base, heardAt = time[0];
  const end = n / RATE, start = Math.max(0, end - WIN);
  const t0 = performance.now();
  const o = await ids(slice(Math.floor(start * RATE), n));
  const ms = performance.now() - t0;
  const upto = final ? end : end - RIGHT, tent = [];
  for (let k = 0; k < o.length; k++) {
    const at = start + k * (end - start) / o.length;
    if (at >= keptUntil && at < upto) kept.push(o[k]);
    else if (at >= Math.max(keptUntil, upto)) tent.push(o[k]);
  }
  keptUntil = Math.max(keptUntil, upto);
  readUpTo = end;
  // lag: from when the newest sample read came in, to its letters being out
  postMessage({ type: 'text', final: decode(kept), tent: final ? '' : decode(tent), ms, lag: now() - heardAt, end });
}

// keep reading while the recitation goes on
async function loop() {
  while (live) {
    if ((written() - base) / RATE - readUpTo >= MIN_NEW) await step(false);
    else await new Promise(r => setTimeout(r, 15));
  }
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    if (data.type === 'start') {
      live = false; await looping;
      base = written(); kept = []; keptUntil = 0; readUpTo = 0;
      live = true; looping = loop();
    }
    if (data.type === 'audio') { // no shared memory: the page sends the samples
      const s = data.samples, w = written();
      for (let i = 0; i < s.length; i++) ring[(w + i) % ring.length] = s[i];
      time[0] = data.at; meta[0] = w + s.length;
    }
    if (data.type === 'flush') {
      live = false; await looping;
      if (written() - base > 0) await step(true);
      postMessage({ type: 'flushed' });
    }
  } catch (e) {
    postMessage({ type: 'error', message: String(e.message || e) });
  }
};
