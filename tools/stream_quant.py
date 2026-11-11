# stream.onnx -> every Gemm a MatMul + Add (so it is made 8-bit as the app's q8 is: the weights
# uint8, per tensor, the activations as they come), then the 8-bit model
#   python stream_quant.py dir
import sys, onnx, numpy as np
from onnx import helper, numpy_helper
from onnxruntime.quantization import quantize_dynamic, QuantType
D = sys.argv[1]
import onnxruntime as ort
so = ort.SessionOptions(); so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC; so.optimized_model_filepath = f'{D}/stream_basic.onnx'
ort.InferenceSession(f'{D}/stream.onnx', so, providers=['CPUExecutionProvider'])   # (constants folded: every weight an initializer)
m = onnx.load(f'{D}/stream_basic.onnx')
init = {i.name: i for i in m.graph.initializer}
nodes = []
for n in m.graph.node:
    if n.op_type != 'Gemm': nodes.append(n); continue
    at = {a.name: helper.get_attribute_value(a) for a in n.attribute}
    assert at.get('alpha', 1) == 1 and at.get('beta', 1) == 1 and n.input[1] in init, n.name
    a_in = n.input[0]
    if at.get('transA', 0):
        a_in = n.output[0] + '_tA'; nodes.append(helper.make_node('Transpose', [n.input[0]], [a_in], perm=[1, 0], name=n.name + '_tA'))
    w = numpy_helper.to_array(init[n.input[1]])
    if at.get('transB', 0): w = w.T
    wn = n.input[1] + '_mm'
    if wn not in init:
        t = numpy_helper.from_array(np.ascontiguousarray(w), wn); m.graph.initializer.append(t); init[wn] = t
    mid = n.output[0] + '_mm'
    nodes.append(helper.make_node('MatMul', [a_in, wn], [mid if len(n.input) > 2 else n.output[0]], name=n.name + '_mm'))
    if len(n.input) > 2: nodes.append(helper.make_node('Add', [mid, n.input[2]], [n.output[0]], name=n.name + '_add'))
del m.graph.node[:]; m.graph.node.extend(nodes)
used = {i for n in m.graph.node for i in n.input}
keep = [i for i in m.graph.initializer if i.name in used]
del m.graph.initializer[:]; m.graph.initializer.extend(keep)
onnx.save(m, f'{D}/stream_mm.onnx')
inits = {i.name for i in m.graph.initializer}
act = [n.name for n in m.graph.node if n.op_type == 'MatMul' and not any(x in inits for x in n.input)]
print('weight matmuls', sum(n.op_type == 'MatMul' for n in m.graph.node) - len(act), 'activation matmuls', len(act))
quantize_dynamic(f'{D}/stream_mm.onnx', f'{D}/stream_q8.onnx', op_types_to_quantize=['MatMul'], weight_type=QuantType.QUInt8, nodes_to_exclude=act)
print('done')
