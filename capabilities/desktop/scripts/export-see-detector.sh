#!/bin/bash
# 把 OmniParser V2 的 icon_detect（YOLOv8）导成 Stream Desktop 吃的 `see-detector.onnx`（imgsz=640，输出 [1,5,8400]）。
# 用法：export-see-detector.sh [输出目录]   → <输出目录>/icon_detect/model.onnx
# 之后 cp 到 agent exe 旁边命名 see-detector.onnx（或 STREAM_SEE_DETECTOR 指过去）。需要 python3 + 网络（HF）。
# 本机实测（2026-09-07）：导出 76.7MB；一张 1946×1045 整窗 35 个框。推理走和读屏同一份 ONNX Runtime
# （`see_detect.rs`），耗时没在 ort 上单独量过——要数字去 see-probe 回执的 elementsIconsMs − elementsMs。
set -eu
V=$HOME/.venvs/omniparser
OUT=${1:-/tmp/see-detector-export}
mkdir -p $OUT
if [ ! -x $V/bin/python ]; then python3 -m venv $V; fi
$V/bin/pip install -q --upgrade pip
$V/bin/pip install -q ultralytics huggingface_hub onnx onnxslim onnxruntime 2>&1 | tail -3
cat > $OUT/export.py <<'EOF'
import os, sys, time
from huggingface_hub import hf_hub_download
out = sys.argv[1]
t0 = time.time()
p = hf_hub_download("microsoft/OmniParser-v2.0", "icon_detect/model.pt", local_dir=out)
print("downloaded", p, os.path.getsize(p), "bytes in", round(time.time()-t0,1), "s")
from ultralytics import YOLO
m = YOLO(p)
print("names", m.names)
f = m.export(format="onnx", imgsz=640, opset=17, simplify=True, dynamic=False)
print("exported", f, os.path.getsize(f), "bytes")
import onnx
mm = onnx.load(f)
for o in mm.graph.output:
    print("output", o.name, [d.dim_value for d in o.type.tensor_type.shape.dim])
for i in mm.graph.input:
    print("input", i.name, [d.dim_value for d in i.type.tensor_type.shape.dim])
EOF
$V/bin/python $OUT/export.py $OUT
echo DONE
