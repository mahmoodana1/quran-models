# lib

Copies of the libraries the Quran app's recitation check (التسميع) runs, served from here
so the app does not depend on a CDN:

- `transformers@3.7.5/` — Hugging Face transformers.js (Apache-2.0), `dist/transformers.min.js`
  and the onnxruntime build it loads (`ort-wasm-simd-threaded.jsep.*`), from npm.
- `onnxruntime-web@1.31.1/` — Microsoft ONNX Runtime Web (MIT), `ort.webgpu.min.mjs` and the
  build it loads (`ort-wasm-simd-threaded.asyncify.*`), from npm.

Unchanged from the published packages; each folder carries its licence.
