# compare an ONNX model's output with the PyTorch reference
import sys, json, time, numpy as np, onnxruntime as ort
M, OUT = sys.argv[1], sys.argv[2]
vocab = json.load(open(sys.argv[3]))['id_to_char']
ref = json.load(open(f'{OUT}/ref.json'))
def dec(ids):
    out, prev = [], None
    for i in ids:
        if i != prev and i != 0: out.append(vocab[i])
        prev = i
    return ''.join(out)
so = ort.SessionOptions(); so.intra_op_num_threads = 4
s = ort.InferenceSession(M, so, providers=['CPUExecutionProvider'])
for name in ref:
    x = np.load(f'{OUT}/{name}.feat.npy'); want = np.load(f'{OUT}/{name}.logits.npy')
    t = time.time(); lg = s.run(None, {'input_features': x})[0]; dt = time.time() - t
    got = dec(lg[0].argmax(-1).tolist())
    agree = (lg[0].argmax(-1) == want[0].argmax(-1)).mean()
    print(f'{name} {dt:.2f}s frames-agree {agree*100:.2f}% maxdiff {np.abs(lg-want).max():.3f} same-text {got == ref[name]}')
    if got != ref[name]: print('   got ', got); print('   want', ref[name])
