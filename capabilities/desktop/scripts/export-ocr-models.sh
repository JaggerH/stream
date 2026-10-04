#!/usr/bin/env bash
# PP-OCRv5 mobile → Stream Desktop 读屏用的 ONNX 三件（ocr-det.onnx / ocr-rec.onnx / ocr-rec-dict.txt）。
#
# 做的事：清掉上游 ONNX 里带符号维度的中间 value_info、把 batch 钉成 1、让输出形状自己推；
# 字典嵌在 rec 模型的 metadata_props['character'] 里，一并抽出来。**产物已钉哈希**
# （platforms/models.sha256，挂在 release desktop-models-v1）——改这里的任何一步 = 换模型，
# 要新 release tag + 改那份 sha256 一起动，别只改脚本。
set -euo pipefail
# 落点是**平台包目录**，因为 agent 按 exe 同目录找这三个文件（`ocr.rs` 的 `load`）。
# 放错了地方的表现是 readText 报 `ocr-missing`——要到第一次读屏才看得见，`/api/health` 照绿。
# 改平台包目录名时这一行要跟着改。
OUT="${1:-capabilities/desktop/platforms/desktop-win32-x64/bin}"
VENV="${VENV:-$HOME/.venvs/omniparser}"
"$VENV/bin/pip" install -q rapidocr onnx
SRC="$("$VENV/bin/python" -c 'import rapidocr,os;print(os.path.join(os.path.dirname(rapidocr.__file__),"models"))')"
"$VENV/bin/python" - "$SRC" "$OUT" <<'PY'
import sys, os, onnx
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
def fix(name, dst):
    m = onnx.load(os.path.join(src, name)); g = m.graph
    del g.value_info[:]
    for inp in g.input:
        d = inp.type.tensor_type.shape.dim[0]; d.ClearField("dim_param"); d.dim_value = 1
    del g.output[0].type.tensor_type.shape.dim[:]
    onnx.save(m, os.path.join(out, dst)); return m
fix("ch_PP-OCRv5_det_mobile.onnx", "ocr-det.onnx")
m = fix("ch_PP-OCRv5_rec_mobile.onnx", "ocr-rec.onnx")
chars = next(p.value for p in m.metadata_props if p.key == "character")
open(os.path.join(out, "ocr-rec-dict.txt"), "w", encoding="utf-8").write(chars)
print("chars:", len(chars.split("\n")))
PY
