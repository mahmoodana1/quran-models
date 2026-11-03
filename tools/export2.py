# export with the 1x1 convolutions as plain matrix products, so they can be quantized too
import sys, numpy as np, torch
from transformers import AutoModel
M, OUT = sys.argv[1], sys.argv[2]
model = AutoModel.from_pretrained(M, trust_remote_code=True).eval()

class Pointwise(torch.nn.Module):
    def __init__(s, conv):
        super().__init__()
        s.lin = torch.nn.Linear(conv.in_channels, conv.out_channels, bias=conv.bias is not None)
        s.lin.weight.data = conv.weight.data[:, :, 0].clone()
        if conv.bias is not None: s.lin.bias.data = conv.bias.data.clone()
    def forward(s, x): return s.lin(x.transpose(1, 2)).transpose(1, 2)

n = 0
for mod in model.modules():
    for name, ch in list(mod.named_children()):
        if isinstance(ch, torch.nn.Conv1d) and ch.kernel_size == (1,) and ch.groups == 1:
            setattr(mod, name, Pointwise(ch)); n += 1
print('pointwise convs replaced', n)

class W(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, input_features): return s.m(input_features).logits['phonemes']
x = torch.from_numpy(np.load(f'{OUT}/h067001.feat.npy'))
with torch.no_grad():
    want = np.load(f'{OUT}/h067001.logits.npy'); got = W(model)(x).numpy()
print('torch maxdiff after rewrite', np.abs(got - want).max())
# the rotary embedding caches its last length; a cached one would be traced as a constant
for mod in model.modules():
    if hasattr(mod, 'cached_sequence_length'): mod.cached_sequence_length = None; mod.cached_rotary_positional_embedding = None
torch.onnx.export(W(model), (x,), f'{OUT}/model2.onnx', input_names=['input_features'], output_names=['logits'],
                  dynamic_axes={'input_features': {0: 'b', 1: 't'}, 'logits': {0: 'b', 1: 't2'}}, opset_version=17, dynamo=False)
