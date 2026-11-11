import json, numpy as np, torch, sys
from transformers import AutoModel, AutoFeatureExtractor
M='hf/mini'
def load():
    # (the repo's own class doesn't import on this transformers: the same model put together here)
    from transformers import Wav2Vec2BertConfig, Wav2Vec2BertModel
    from safetensors.torch import load_file
    cfg = Wav2Vec2BertConfig(**{k: v for k, v in json.load(open(M + '/config.json')).items() if k not in ('architectures', 'auto_map', 'model_type', 'transformers_version', 'dtype')})
    class Out:
        def __init__(s, l): s.logits = {'phonemes': l}
    class Model(torch.nn.Module):
        def __init__(s):
            super().__init__()
            s.wav2vec2_bert = Wav2Vec2BertModel(cfg)
            s.level_to_lm_head = torch.nn.ModuleDict({'phonemes': torch.nn.Linear(cfg.output_hidden_size, 43)})
        def forward(s, input_features, attention_mask=None):
            return Out(s.level_to_lm_head['phonemes'](s.wav2vec2_bert(input_features, attention_mask=attention_mask)[0]))
    model = Model()
    sd = load_file(M + '/model.safetensors')
    miss = model.load_state_dict(sd, strict=False)
    bad = [k for k in miss.missing_keys if 'masked_spec_embed' not in k] + list(miss.unexpected_keys)
    assert not bad, bad[:10]
    model.eval()
    fe = AutoFeatureExtractor.from_pretrained(M)
    vocab = json.load(open(M + '/phoneme_vocab.json'))['id_to_char']
    return model, fe, vocab
def dec(ids, vocab):
    out, prev = [], None
    for i in ids:
        if i != prev and i != 0: out.append(vocab[i])
        prev = i
    return ''.join(out)
def feats(fe, a):
    return torch.from_numpy(fe(a, sampling_rate=16000, return_tensors='np')['input_features'][0])
def audio(r, f): return np.fromfile(f'audio/{r}/{f}.f32', dtype=np.float32)
def ed(a, b):
    p = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        c = [i]
        for j, y in enumerate(b, 1): c.append(min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (x != y)))
        p = c
    return p[-1]
