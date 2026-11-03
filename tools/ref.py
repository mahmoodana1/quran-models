# reference transcripts from the PyTorch model, then the ONNX export
import sys, json, time, numpy as np, torch
from transformers import AutoModel, AutoFeatureExtractor
M, B, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
model = AutoModel.from_pretrained(M, trust_remote_code=True).eval()
fe = AutoFeatureExtractor.from_pretrained(M)
vocab = json.load(open(M + '/phoneme_vocab.json'))['id_to_char']
def dec(ids):
    out, prev = [], None
    for i in ids:
        if i != prev and i != 0: out.append(vocab[i])
        prev = i
    return ''.join(out)
ref = {}
for name in ['h001002', 'h067001', 'h002255']:
    a = np.fromfile(f'{B}/{name}.f32', dtype=np.float32)
    x = fe(a, sampling_rate=16000, return_tensors='pt')
    t = time.time()
    with torch.no_grad(): lg = model(x['input_features'], attention_mask=x['attention_mask']).logits['phonemes']
    ref[name] = dec(lg[0].argmax(-1).tolist())
    np.save(f'{OUT}/{name}.feat.npy', x['input_features'].numpy()); np.save(f'{OUT}/{name}.logits.npy', lg.numpy())
    print(name, x['input_features'].shape, f'{time.time()-t:.2f}s', ref[name])
json.dump(ref, open(f'{OUT}/ref.json', 'w'), ensure_ascii=False)

class W(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, input_features): return s.m(input_features).logits['phonemes']
x = torch.from_numpy(np.load(f'{OUT}/h067001.feat.npy'))
torch.onnx.export(W(model), (x,), f'{OUT}/model.onnx', input_names=['input_features'], output_names=['logits'],
                  dynamic_axes={'input_features': {0: 'b', 1: 't'}, 'logits': {0: 'b', 1: 't2'}}, opset_version=17, dynamo=False)
print('exported')
