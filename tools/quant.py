# 8-bit (all weight matmuls) and 4-bit (block-wise) versions of model2.onnx
import sys, onnx, re
from onnxruntime.quantization import quantize_dynamic, QuantType
OUT = sys.argv[1]
m = onnx.load(f'{OUT}/model2.onnx', load_external_data=False)
inits = {i.name for i in m.graph.initializer}
act = [n.name for n in m.graph.node if n.op_type == 'MatMul' and not any(x in inits for x in n.input)]
quantize_dynamic(f'{OUT}/model2.onnx', f'{OUT}/m2_q8.onnx', op_types_to_quantize=['MatMul'], weight_type=QuantType.QUInt8, nodes_to_exclude=act)
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
for bs in (32, 64):
    q = MatMulNBitsQuantizer(onnx.load(f'{OUT}/model2.onnx'), block_size=bs, is_symmetric=False, accuracy_level=4)
    q.process(); q.model.save_model_to_file(f'{OUT}/m2_q4_{bs}.onnx', use_external_data_format=False)
print('done')
