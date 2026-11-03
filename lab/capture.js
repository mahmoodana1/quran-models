// Runs on the browser's audio thread: takes whatever is connected to it
// (the microphone, or a recitation being played), brings it to 16 kHz and
// writes it straight into the ring shared with the model's worker, so the
// page's main thread is never in the way of the sound.
// Without shared memory it sends the samples to the page in blocks instead.
class Tap extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    this.step = sampleRate / 16000; // input samples per output sample
    this.phase = 0;                 // position of the next output sample in the input
    this.prev = 0;                  // last input sample of the previous block
    this.clock0 = o.clock0;         // wall clock (ms) at currentTime 0
    if (o.shared) ({ ring: this.ring, meta: this.meta, time: this.time } = o.shared);
    else { this.buf = new Float32Array(1024); this.n = 0; }
    this.on = true;
    this.port.onmessage = e => { if (e.data === 'stop') this.on = false; };
  }
  write(y) {
    if (this.ring) this.ring[this.w++ % this.ring.length] = y;
    else {
      this.buf[this.n++] = y;
      if (this.n === this.buf.length) { this.port.postMessage({ samples: this.buf, at: this.clock0 + currentTime * 1000 }, [this.buf.buffer]); this.buf = new Float32Array(1024); this.n = 0; }
    }
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (x && x.length) {
      // linear interpolation between input samples, carrying the phase across blocks
      let p = this.phase;
      if (this.ring) this.w = Atomics.load(this.meta, 0);
      while (p < x.length) {
        const k = Math.floor(p), f = p - k;
        const a = k < 0 ? this.prev : x[k], b = k + 1 < x.length ? x[k + 1] : x[k];
        this.write(a + (b - a) * f);
        p += this.step;
      }
      this.phase = p - x.length;
      this.prev = x[x.length - 1];
      if (this.ring) { this.time[0] = this.clock0 + currentTime * 1000; Atomics.store(this.meta, 0, this.w); }
    }
    return this.on;
  }
}
registerProcessor('tap', Tap);
