"""拿人耳标注当真值，验「非人声碎片」这条判据：摘掉的到底是不是掌声。

这条改动动的是**时间线**——删错一段，「这个人说过话」这个事实就消失了，不可恢复
（2026-07-27 那次证伪的教训）。所以它的验收标准不是「归属正确率涨了」，而是
**精确率必须是 100%**：凡是被摘掉的，人耳都得同意它是掌声/笑声。召回低无所谓，
留着一个错簇的代价远小于删掉一句真话。

真值：`data/voiceprint-spike/e02-shard-labels.json`（用户逐段听 52 段的标注，
`heard:false` 的不算）。

用法（在容器里跑——判据的两半都在 app.py 里，不复制一份免得口径分叉）：

    docker compose up -d voiceprint
    docker cp scripts/voiceprint-shard-drop-check.py stream-voiceprint-1:/tmp/
    docker cp data/voiceprint-spike/e02-audio.mka stream-voiceprint-1:/tmp/audio.mka
    docker cp data/voiceprint-spike/e02-shard-labels.json stream-voiceprint-1:/tmp/labels.json
    docker exec stream-voiceprint-1 python -u /tmp/voiceprint-shard-drop-check.py \
        /tmp/audio.mka /tmp/labels.json
"""
import json, os, sys

sys.path.insert(0, os.environ.get("VOICEPRINT_SRC", "/src"))
import app  # noqa: E402

AUDIO, LABELS = sys.argv[1], sys.argv[2]
if app._load_tagger() is None:
    sys.exit("门控模型不可用，没什么可验的")

audio, sr = app._read_audio(open(AUDIO, "rb").read())
rows = [r for r in json.load(open(LABELS)) if r.get("heard")]
print(f"音轨 {len(audio)/sr:.0f}s；人耳标注 {len(rows)} 段（听过的）")

# 逐段问「帧标签这一半」怎么判。结构那一半在活体是按窗判的，这里用标注自带的 cluster
# 当结构判定的结果（这些簇正是结构筛出来的那 7 个），只验帧标签这一半的刀口。
tp = fp = kept_noise = kept_speech = 0
tp_s = fp_s = 0.0
for r in rows:
    frac = app._speech_frac(audio, sr, r["start"], r["end"])
    drop = frac is not None and frac <= app.SHARD_SPEECH_MAX
    isnoise = r["label"] == "noise"
    d = r["end"] - r["start"]
    if drop and isnoise:
        tp += 1
        tp_s += d
    elif drop and not isnoise:
        fp += 1
        fp_s += d
        print(f"  ✗ 误删 {r['cluster']} {r['start']:.2f}..{r['end']:.2f} "
              f"人耳={r['label']} 帧={frac:.0%}")
    elif isnoise:
        kept_noise += 1
    else:
        kept_speech += 1

print(f"\n摘掉 {tp+fp} 段：对 {tp}（{tp_s:.0f}s）/ 错 {fp}（{fp_s:.0f}s）")
print(f"精确率 {tp/(tp+fp):.1%}" if tp + fp else "一段都没摘")
print(f"漏掉的掌声 {kept_noise} 段（无妨——留着只是多一个错簇）")
print(f"正确保留的真人发言 {kept_speech} 段")
if fp:
    sys.exit(f"\n❌ 精确率不是 100%：误删了 {fp} 段真人发言，判据不能上线")
print("\n✅ 精确率 100%：摘掉的每一段人耳都判为掌声/笑声")
