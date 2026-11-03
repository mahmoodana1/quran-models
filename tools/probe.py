# tiny stand-ins for choosing a model on a device: the first two encoder layers
# of each variant, with every large weight replaced by a ConstantOfShape node
# (filled in when the session loads), so the file is a few KB but the
# computation is the same as in the real model
import sys, numpy as np, onnx, onnx.utils
from onnx import helper, numpy_helper
SRC, OUT = sys.argv[1], sys.argv[2]
LAYER_OUT = '/m/wav2vec2_bert/encoder/layers.1/final_layer_norm/LayerNormalization_output_0'
for name, path in [('q8', 'm2_q8.onnx'), ('q4', 'm2_q4_32.onnx'), ('fp16', 'm2_fp16.onnx')]:
    m = onnx.load(f'{SRC}/{path}')
    # keep only the nodes the layer output depends on (walking back from it)
    need, keep_ids, grew = {LAYER_OUT}, set(), True
    while grew:  # until nothing new is needed (nodes are not always in order)
        grew = False
        for k, n in enumerate(m.graph.node):
            if k not in keep_ids and any(o in need for o in n.output):
                keep_ids.add(k); need.update(i for i in n.input if i); grew = True
    nodes_kept = [n for k, n in enumerate(m.graph.node) if k in keep_ids]
    del m.graph.node[:]; m.graph.node.extend(nodes_kept)
    inits = [i for i in m.graph.initializer if i.name in need]
    del m.graph.initializer[:]; m.graph.initializer.extend(inits)
    del m.graph.output[:]; m.graph.output.append(helper.make_tensor_value_info(LAYER_OUT, onnx.TensorProto.FLOAT16 if name == 'fp16' else onnx.TensorProto.FLOAT, None))
    del m.graph.value_info[:]
    keep, nodes = [], []
    for init in m.graph.initializer:
        a = numpy_helper.to_array(init)
        if a.size < 4096: keep.append(init); continue
        fill = np.array([1 if a.dtype.kind in 'iu' else 0.01], dtype=a.dtype)
        shape = helper.make_tensor(init.name + '_shape', onnx.TensorProto.INT64, [a.ndim], list(a.shape))
        nodes.append(helper.make_node('ConstantOfShape', [init.name + '_shape'], [init.name], value=numpy_helper.from_array(fill)))
        keep.append(shape)
    del m.graph.initializer[:]
    m.graph.initializer.extend(keep)
    old = list(m.graph.node); del m.graph.node[:]; m.graph.node.extend(nodes + old)
    onnx.save(m, f'{OUT}/{name}.onnx')
    import os
    print(name, os.path.getsize(f'{OUT}/{name}.onnx'), 'bytes')
