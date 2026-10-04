"""帧门控的并行等价性：`_gate_spans` 在 jobs=1 与 jobs=N 下必须给出**逐位相同**的结果。

并行只该改墙钟。它一旦改了判定（哪几帧留下、攒了多少秒），下游的代表、弃权、跨窗合并
全部跟着变，而这种变化**不会报错**——只会静默把脏向量写进声纹库。所以动过 `_gate_spans`
（或换过 sherpa-onnx / tagger 模型）之后跑这个，别靠"ORT 应该是线程安全的"。

顺带打墙钟，用来判断并行度还值不值得往上调。

用法（脚本要进容器跑——容器只 bind-mount `containers/voiceprint`）：

    docker compose up -d voiceprint
    docker cp scripts/voiceprint-gate-parity.py stream-voiceprint-1:/tmp/
    docker cp <某集音轨>.mka stream-voiceprint-1:/tmp/audio.mka
    docker cp data/voiceprint-spike/ab-e02r-off stream-voiceprint-1:/tmp/dump
    docker exec stream-voiceprint-1 python /tmp/voiceprint-gate-parity.py /tmp/audio.mka /tmp/dump

`dump` 是 `scripts/voiceprint-dump-clusters.ts` 落的窗 JSON（要 `startS`/`durS`/`segments`），
用它只为拿**真实的 span 形状**——短段多、长段少那种分布，凑批的填充率全靠它。
"""
import json, os, sys, time

sys.path.insert(0, os.environ.get("VOICEPRINT_SRC", "/src"))
import app  # noqa: E402

if len(sys.argv) < 3:
    sys.exit(__doc__)
AUDIO, DUMP = sys.argv[1], sys.argv[2]
JOBS = int(sys.argv[3]) if len(sys.argv) > 3 else 4

if app._load_tagger() is None:
    sys.exit("门控模型不可用（VOICEPRINT_FRAME_GATE=0 或模型没拉下来）——没什么可验的")

audio, sr = app._read_audio(open(AUDIO, "rb").read())
print(f"音轨 {len(audio)/sr:.0f}s @ {sr}Hz", flush=True)

wins = sorted(
    (json.load(open(os.path.join(DUMP, n))) for n in os.listdir(DUMP) if n.startswith("window-")),
    key=lambda w: w["index"],
)
n = same = 0
t1 = tn = 0.0
for w in wins:
    a0 = int(w["startS"] * sr)
    clip = audio[a0 : min(len(audio), a0 + int(w["durS"] * sr))]
    spans = {}
    for s in w["segments"]:
        spans.setdefault(s["speaker"], []).append((s["start"], s["end"]))
    for spk, ss in sorted(spans.items()):
        out = {}
        for jobs in (1, JOBS):
            app.GATE_JOBS = jobs
            t = time.time()
            out[jobs] = app._gate_spans(clip, sr, ss, app.REP_CLIP_S)
            el = time.time() - t
            t1 += el if jobs == 1 else 0
            tn += el if jobs != 1 else 0
        n += 1
        if out[1] == out[JOBS]:
            same += 1
        else:
            print(f"  ✗ 窗{w['index']} {spk}\n    jobs=1    {out[1]!r}\n    jobs={JOBS} {out[JOBS]!r}")

print(f"\n{len(wins)} 窗 / {n} 个说话人：逐位相同 {same}/{n}")
print(f"墙钟 jobs=1 {t1:.1f}s → jobs={JOBS} {tn:.1f}s = {t1/max(tn,1e-9):.2f}×")
if same != n:
    sys.exit("并行改变了门控判定 —— 禁止上线")
print("OK")
