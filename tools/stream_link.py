# the stream model as a graph alone: its weights are the ones already inside the app's q8.onnx (the
# same matrices, made 8-bit the same way), so each is pointed there (external data: file, offset,
# length) instead of shipped again. A device that has q8 downloads a few hundred KB, not 126 MB.
#   python stream_link.py stream_q8.onnx q8.onnx out.onnx
import sys, hashlib, onnx
from onnx import TensorProto
SRC, Q8, OUT = sys.argv[1:4]
buf = open(Q8, 'rb').read()
def varint(p):
    v = s = 0
    while True:
        b = buf[p]; p += 1; v |= (b & 0x7f) << s; s += 7
        if b < 0x80: return v, p
def fields(a, b):  # (field, wire, start, end) of each field in buf[a:b]
    p = a
    while p < b:
        k, p = varint(p); f, w = k >> 3, k & 7
        if w == 0: _, q = varint(p); yield f, w, p, q; p = q
        elif w == 2: n, p = varint(p); yield f, w, p, p + n; p += n
        elif w == 5: yield f, w, p, p + 4; p += 4
        elif w == 1: yield f, w, p, p + 8; p += 8
        else: raise ValueError(w)
have = {}  # (dtype, sha of the bytes) -> (offset, length)
for f, w, a, b in fields(0, len(buf)):
    if f != 7: continue                      # ModelProto.graph
    for f2, w2, a2, b2 in fields(a, b):
        if f2 != 5: continue                 # GraphProto.initializer
        dt = raw = None
        for f3, w3, a3, b3 in fields(a2, b2):
            if f3 == 2: dt = varint(a3)[0]   # TensorProto.data_type
            if f3 == 9: raw = (a3, b3 - a3)  # TensorProto.raw_data
        if raw and raw[1] >= 1024: have[(dt, hashlib.sha1(buf[raw[0]:raw[0] + raw[1]]).digest())] = raw
m = onnx.load(SRC)
linked = kept = 0
for t in m.graph.initializer:
    if not t.raw_data or len(t.raw_data) < 1024: kept += len(t.raw_data); continue
    hit = have.get((t.data_type, hashlib.sha1(t.raw_data).digest()))
    if not hit: kept += len(t.raw_data); print('  not in q8:', t.name, list(t.dims), len(t.raw_data)); continue
    linked += len(t.raw_data)
    t.ClearField('raw_data'); t.data_location = TensorProto.EXTERNAL
    for k, v in (('location', 'q8.onnx'), ('offset', hit[0]), ('length', hit[1])):
        e = t.external_data.add(); e.key = k; e.value = str(v)
onnx.save(m, OUT)
print(f'linked {linked / 1e6:.1f} MB, kept inline {kept / 1e6:.2f} MB')
