# quran-models

Speech models for the recitation feature (التسميع) of [mahmoodana1/quran](https://github.com/mahmoodana1/quran), converted to run in the browser, plus a page for trying them on a phone.

**Phone lab:** https://mahmoodana1.github.io/quran-models/lab/

## Muaalem mini

[`sysofwan/hifzguide-muaalem-mini`](https://huggingface.co/sysofwan/hifzguide-muaalem-mini) is a distilled Wav2Vec2-BERT model of Quran recitation (116 M parameters). It writes what the reciter actually said in the Quran phonetic script (letters, harakat, madd lengths), which is what makes checking harakat possible.

The conversion is in `tools/`:

1. Every 1×1 convolution is rewritten as the equivalent matrix product (`export2.py`), so it can be quantized as well.
2. The rotary-embedding cache is cleared before export, so any audio length works.
3. The model is exported to ONNX (opset 17) and checked against PyTorch on three Husary recordings (`check.py`).

| Variant | File | Size | Frames matching the full model |
|---|---|---|---|
| `q8` | 8-bit weights (dynamic, per-tensor uint8), graph pre-optimized | 126 MB | 99.4–100% |
| `q4` | 4-bit weights (block 32, MatMulNBits) | 86 MB | 98.9–100% |
| `fp16` | half precision, float32 input and output | 234 MB | 99.9–100% |

The few frames that differ are almost all madd lengths (one beat longer or shorter).

GitHub Pages serves files of up to 100 MB, so each variant is split into parts of up to 90 MB. `muaalem/manifest.json` lists the parts in order with their sizes and SHA-256 hashes. Join them in order to get the `.onnx` file.

- **Input:** `input_features` `[1, T, 160]` float32, from the SeamlessM4T feature extractor in `muaalem/preprocessor_config.json`.
- **Output:** `logits` `[1, T/2, 43]` at 25 frames per second.
- **Decoding:** greedy CTC; id 0 is blank, and `muaalem/phoneme_vocab.json` maps the ids to characters.

### Reading as you recite

Every time at least 0.25 s of new audio has come in, the last 2.5 s are read again:
- Output frames that have at least 0.5 s of audio after them are final.
- Newer frames are shown as tentative.

In Chromium on 4 cores this takes about 250 ms per update, and gives the same text as reading the whole aya at once. A 2 s window starts to make mistakes.

### As a stream

Reading the last 4 s again for every update computes each second of audio four times or more. `muaalem/stream/s8.onnx` is the same model, with the same 8-bit weights, cut so that an update computes only the frames that are not settled yet: the last second, and what has come in since. Those frames attend to the layer states of the 2 s before them, which are kept from the updates before instead of being computed again (per layer: the attention's input and values, and the 30 frames the causal convolution looks back on; then the adapter's).

- An update costs a third to a half of a 4 s window (in Chromium on one core: 480 ms for 0.25 s of new audio, against 1330 ms).
- The text is as close to the truth as with windows, or closer. On 12 ayat by three reciters, read every 0.5 s: 5, 9 and 5 sounds wrong with the stream, against 7, 10 and 9 with windows.
- The model hears a frame worse the further it is into its input (past 5 s or so), so the cache is 2 s (`cache` in the manifest, in frames) and a catch-up read is at most 3 s.
- The file is the graph alone (760 KB). Its weights are the ones inside `q8.onnx`: each is external data pointing at its bytes there (`location`, `offset`, `length`), so a device that has the 8-bit model downloads nothing more. Load it with the joined `q8.onnx` given as that external file.

How it is made (`tools/`): `stream_export.py` (the cut model, checked against the whole one), `stream_quant.py` (8-bit, as `q8` is), `stream_link.py` (the weights pointed into `q8.onnx`), `stream_probe.py` (its stand-in for timing a device, `probe/s8.onnx`).

## Licence

The weights are a derivative of `hifzguide-muaalem-mini`, so they are licensed under **AGPL-3.0** (`LICENSE`); see `muaalem/NOTICE.md` for the lineage (Muaalem by obadx, MIT). The lab and the conversion scripts are AGPL-3.0 as well.

## Whisper (the other riwayat)

`whisper/` keeps copies of the two Quran Whisper models the app uses outside Hafs, in the layout transformers.js expects (`env.remoteHost` points here):

- `An0xity/whisper-base-ar-quran-onnx-timestamped` (8-bit): an ONNX export of [`tarteel-ai/whisper-base-ar-quran`](https://huggingface.co/tarteel-ai/whisper-base-ar-quran).
- `Sharjeelbaig/whisper-tiny-ar-quran-onnx` (encoder fp32, decoder 8-bit): an ONNX export of [`tarteel-ai/whisper-tiny-ar-quran`](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran).
- `deepdml/whisper-tiny-ar-quran-mix-norm` (encoder fp32, decoder 8-bit in its word table and last projection only): our ONNX export of [`deepdml/whisper-tiny-ar-quran-mix-norm`](https://huggingface.co/deepdml/whisper-tiny-ar-quran-mix-norm) (`tools/whisper_mix_norm.py`). In Hafs, a second opinion on fast readings (hadr), which it hears far better than the phonetic model.

All three are Apache-2.0, like the models they come from.
