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

## Licence

The weights are a derivative of `hifzguide-muaalem-mini`, so they are licensed under **AGPL-3.0** (`LICENSE`); see `muaalem/NOTICE.md` for the lineage (Muaalem by obadx, MIT). The lab and the conversion scripts are AGPL-3.0 as well.
