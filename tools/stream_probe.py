# the stream's stand-in for timing a device: its first two layers (as stream_export.py has them), 8-bit,
# every large weight filled in on load (ConstantOfShape), so the file is a few KB
#   python stream_probe.py out.onnx
import sys, os, tempfile, numpy as np, torch, onnx, torch.nn.functional as F
from onnx import helper, numpy_helper
from common import load
from stream_export import StreamX, H, K
class Probe(StreamX):
    def forward(s, feats, att, val, conv, mask, off):
        x = s.w.feature_projection.projection(s.w.feature_projection.layer_norm(feats))
        N, C = x.shape[0], att.shape[1]
        t = torch.arange(C + N, dtype=torch.float32) - off
        f = t[:, None] * s.inv_freq; e = torch.cat((f, f), -1)
        cos, sin = e.cos()[:, None, :], e.sin()[:, None, :]
        bias = torch.cat((mask, torch.zeros(N)), 0)
        outs = []
        for i, l in enumerate(s.w.encoder.layers[:2]):
            x = l.ffn1(l.ffn1_layer_norm(x)) * 0.5 + x
            a = l.self_attn_layer_norm(x); v = l.self_attn.linear_v(a)
            rot = s.rotate(torch.cat((att[i], a), 0), cos, sin)
            x = s.attend(l.self_attn, rot[C:], rot, torch.cat((val[i], v), 0), bias) + x
            c = l.conv_module
            g = F.glu(F.linear(c.layer_norm(x), c.pointwise_conv1.weight[:, :, 0]), dim=1).t()
            outs += [a, v, g]
            d = c.depthwise_conv(torch.cat((conv[i], g), 1).unsqueeze(0))[0]
            d = c.activation(c.depthwise_layer_norm(d.t()))
            x = F.linear(d, c.pointwise_conv2.weight[:, :, 0]) + x
            x = l.ffn2(l.ffn2_layer_norm(x)) * 0.5 + x
            x = l.final_layer_norm(x)
        return x, torch.stack(outs[0::3]), torch.stack(outs[1::3]), torch.stack(outs[2::3])
TARGET = sys.argv[1]
model, fe, vocab = load(); P = Probe(model).eval()
d = tempfile.mkdtemp(); C = 200
args = (torch.randn(76, 160), torch.zeros(2, C, H), torch.zeros(2, C, H), torch.zeros(2, H, K - 1), torch.zeros(C), torch.zeros(1))
torch.onnx.export(P, args, f'{d}/stream.onnx', input_names=['feats', 'att', 'val', 'conv', 'mask', 'off'], output_names=['x', 'n_att', 'n_val', 'n_conv'],
                  dynamic_axes={'feats': {0: 'n'}, 'att': {1: 'c'}, 'val': {1: 'c'}, 'mask': {0: 'c'}}, opset_version=17, dynamo=False)
sys.argv = ['', d]; exec(open('stream_quant.py').read())
m = onnx.load(f'{d}/stream_q8.onnx')
keep, nodes = [], []
for init in m.graph.initializer:
    a = numpy_helper.to_array(init)
    if a.size < 4096: keep.append(init); continue
    fill = np.array([1 if a.dtype.kind in 'iu' else 0.01], dtype=a.dtype)
    shape = helper.make_tensor(init.name + '_shape', onnx.TensorProto.INT64, [a.ndim], list(a.shape))
    nodes.append(helper.make_node('ConstantOfShape', [init.name + '_shape'], [init.name], value=numpy_helper.from_array(fill)))
    keep.append(shape)
del m.graph.initializer[:]; m.graph.initializer.extend(keep)
old = list(m.graph.node); del m.graph.node[:]; m.graph.node.extend(nodes + old)
onnx.save(m, TARGET); print(TARGET, os.path.getsize(TARGET), 'bytes')
