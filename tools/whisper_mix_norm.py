# whisper/deepdml/whisper-tiny-ar-quran-mix-norm: deepdml's Quran Whisper tiny (Apache-2.0) for
# transformers.js: the ONNX export as optimum makes it, then the decoder made 8-bit where that costs
# nothing: the word table (Gather) and the last projection to it (proj_out) only. The attention and
# the rest quantized too turn its text to repetitions on a fast reading (hadr); the whole decoder in
# full precision would be 198 MB, this 78. The encoder stays full precision (an 8-bit ConvInteger
# has no implementation in onnxruntime-web).
#   optimum-cli export onnx --model deepdml/whisper-tiny-ar-quran-mix-norm \
#     --task automatic-speech-recognition-with-past onnx-tiny
#   python whisper_mix_norm.py onnx-tiny/decoder_model_merged.onnx decoder_model_merged_quantized.onnx
# (optimum 2.1 on Python 3.14: functools.partial as a class attribute now binds self, so in
# optimum/exporters/base.py, self.NORMALIZED_CONFIG_CLASS(...) has to be type(self).NORMALIZED_CONFIG_CLASS(...))
import sys, onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

src, dst = sys.argv[1:3]
names = set()
def walk(g):
    for n in g.node:
        if n.op_type == 'MatMul': names.add(n.name)
        for a in n.attribute:
            if a.g and a.g.node: walk(a.g)
walk(onnx.load(src).graph)
quantize_dynamic(src, dst, weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul', 'Gather'], per_channel=True,
                 nodes_to_exclude=[n for n in names if 'proj_out' not in n], extra_options={'EnableSubgraph': True})
