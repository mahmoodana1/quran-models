# the stream model for the app: as stream.py, but the cache is always C slots (the settled frames at
# its end, the empty slots before them masked out of the attention), so only the number of new frames
# changes from one read to the next; every weight product a plain matrix product, to be made 8-bit
#   python stream_export.py out_dir [C]
import sys, torch, numpy as np, torch.nn.functional as F
from torch import nn
from common import load
H, HEADS, K, L = 448, 7, 31, 24

class StreamX(nn.Module):
    def __init__(s, model):
        super().__init__()
        s.w = model.wav2vec2_bert; s.head = model.level_to_lm_head['phonemes']
        s.register_buffer('inv_freq', s.w.encoder.embed_positions.inv_freq.clone())
    @staticmethod
    def rotate(x, cos, sin):
        n = x.shape[0]; h = x.view(n, HEADS, H // HEADS); half = H // HEADS // 2
        r = torch.cat((-h[..., half:], h[..., :half]), -1)
        return (h * cos + r * sin).reshape(n, H)
    def attend(s, a, q_in, k_in, v, bias):
        N, M = q_in.shape[0], k_in.shape[0]
        q = a.linear_q(q_in).view(N, HEADS, -1).transpose(0, 1)
        k = a.linear_k(k_in).view(M, HEADS, -1).transpose(0, 1)
        vv = v.view(M, HEADS, -1).transpose(0, 1)
        w = torch.softmax(torch.matmul(q, k.transpose(1, 2)) * a.scaling + bias, -1)
        return a.linear_out(torch.matmul(w, vv).transpose(0, 1).reshape(N, H))
    # feats [N, 160] (N even) · att, val [L, C, H] · conv [L, H, K-1] · last [1, H] · has [1] (0: no frame before)
    # · ad [C/2, H] · mask [C] (0, or -1e4 on an empty slot) · off [1]: the empty slots (positions count from the first real frame)
    def forward(s, feats, att, val, conv, last, has, ad, mask, off):
        x = s.w.feature_projection.projection(s.w.feature_projection.layer_norm(feats))
        N, C = x.shape[0], att.shape[1]
        t = torch.arange(C + N, dtype=torch.float32) - off
        f = t[:, None] * s.inv_freq; e = torch.cat((f, f), -1)
        cos, sin = e.cos()[:, None, :], e.sin()[:, None, :]
        bias = torch.cat((mask, torch.zeros(N)), 0)
        n_att, n_val, n_conv = [], [], []
        for i, l in enumerate(s.w.encoder.layers):
            x = l.ffn1(l.ffn1_layer_norm(x)) * 0.5 + x
            a = l.self_attn_layer_norm(x)
            v = l.self_attn.linear_v(a)
            rot = s.rotate(torch.cat((att[i], a), 0), cos, sin)
            x = s.attend(l.self_attn, rot[C:], rot, torch.cat((val[i], v), 0), bias) + x
            n_att.append(a); n_val.append(v)
            c = l.conv_module
            g = F.glu(F.linear(c.layer_norm(x), c.pointwise_conv1.weight[:, :, 0]), dim=1).t()      # [H, N]
            n_conv.append(g)
            d = c.depthwise_conv(torch.cat((conv[i], g), 1).unsqueeze(0))[0]
            d = c.activation(c.depthwise_layer_norm(d.t()))
            x = F.linear(d, c.pointwise_conv2.weight[:, :, 0]) + x
            x = l.ffn2(l.ffn2_layer_norm(x)) * 0.5 + x
            x = l.final_layer_norm(x)
        A = s.w.adapter.layers[0]
        def sub(conv_, ln):
            y = torch.cat((ln(last) * has, ln(x)), 0).t().unsqueeze(0)
            return F.glu(F.conv1d(y, conv_.weight, conv_.bias, stride=2), dim=1)[0].t()
        res = sub(A.residual_conv, A.residual_layer_norm); h = sub(A.self_attn_conv, A.self_attn_layer_norm)
        allh = torch.cat((ad, h), 0)
        y = s.attend(A.self_attn, h, allh, A.self_attn.linear_v(allh), torch.cat((mask[::2], torch.zeros(N // 2)), 0)) + res
        y = A.ffn(A.ffn_layer_norm(y)) + y
        return s.head(y), torch.stack(n_att), torch.stack(n_val), torch.stack(n_conv), x, h

def blank(C):
    return [torch.zeros(L, C, H), torch.zeros(L, C, H), torch.zeros(L, H, K - 1), torch.zeros(1, H), torch.zeros(1), torch.zeros(C // 2, H), torch.full((C,), -1e4), torch.full((1,), float(C))]
NAMES = ['feats', 'att', 'val', 'conv', 'last', 'has', 'ad', 'mask', 'off']
OUTS = ['logits', 'n_att', 'n_val', 'n_conv', 'enc', 'n_ad']
if __name__ == '__main__':
    out, C = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200
    model, fe, vocab = load(); S = StreamX(model).eval()
    x = torch.randn(76, 160)
    torch.onnx.export(S, (x, *blank(C)), f'{out}/stream.onnx', input_names=NAMES, output_names=OUTS,
                      dynamic_axes={'feats': {0: 'n'}, 'att': {1: 'c'}, 'val': {1: 'c'}, 'ad': {0: 'c2'}, 'mask': {0: 'c'}, 'logits': {0: 'n2'}, 'n_att': {1: 'n'}, 'n_val': {1: 'n'}, 'n_conv': {2: 'n'}, 'enc': {0: 'n'}, 'n_ad': {0: 'n2'}},
                      opset_version=17, dynamo=False)
    print('exported')
