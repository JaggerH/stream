"""口径重量：同一份 A/B dump 上，按「代表口径」分类量重叠区 must-link 距离。

为什么不能直接读 `scripts/voiceprint-spike.ts` 打印的那个 p95：它走 `representativeOf`，
对弃权者退回段级均值，于是量到的是**混口径**距离——一边干净代表、一边段级均值，量的是
两种口径的差，不是「是不是同一个人」。门控 spec §7 记着这个坑（E02 上混着量把 p95 从
0.204 抬到 0.324）。本脚本把配对按口径分箱，各箱单独出数。

must-link（免费真值）：相邻窗重叠 10s，两窗里在重叠区**时间交集最大**的那对局部说话人
就是同一个人。配对规则与 `scripts/voiceprint-spike.ts` 的 `findMustLinks` 逐字一致。

用法：python3 scripts/voiceprint-caliber.py <armDir> [<armDir> ...]
"""
import json, math, os, sys
from itertools import combinations


def unit(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else None


def cos(a, b):
    return sum(x * y for x, y in zip(a, b))


def load(d):
    ws = []
    for name in os.listdir(d):
        if not name.startswith("window-") or not name.endswith(".json"):
            continue
        ws.append(json.load(open(os.path.join(d, name))))
    return sorted(ws, key=lambda w: w["index"])


def clean_reps(w):
    """局部 speaker → 干净单位向量。弃权者与空向量不在结果里（同 cleanRepsOf）。"""
    out = {}
    for sp in w.get("speakers") or []:
        if sp.get("abstained") or not sp.get("embedding"):
            continue
        u = unit(sp["embedding"])
        if u:
            out[sp["speaker"]] = u
    return out


def fallback_reps(w):
    """局部 speaker → 段级时长加权单位均值（同 representativeOf）。"""
    acc = {}
    for s in w["segments"]:
        e = s.get("embedding") or []
        if not any(x != 0 for x in e):
            continue
        u = unit(e)
        if not u:
            continue
        wt = s["end"] - s["start"]
        a = acc.setdefault(s["speaker"], [[0.0] * len(u), 0.0])
        for i, x in enumerate(u):
            a[0][i] += x * wt
        a[1] += wt
    return {k: unit([x / t for x in v]) for k, (v, t) in acc.items() if t > 0 and unit(v)}


def segs_in_overlap(w, ov_s, ov_e):
    out = {}
    for s in w["segments"]:
        a = max(w["startS"] + s["start"], ov_s)
        b = min(w["startS"] + s["end"], ov_e)
        if b > a:
            out.setdefault(s["speaker"], []).append((a, b))
    return out


def must_links(ws, loose=False):
    """重叠区 must-link 配对。

    `loose=False`（默认，**用这个**）逐字复刻生产自己的 `mustLinkP95`
    （`src/voiceprint/windowed.ts`）：每个相邻窗对**只出一对**——两边在重叠区各自占时
    最多的那个局部说话人。三道闸门：重叠 > 1s、主导者占时 ≥ 2s、**第二名超过第一名一半
    就整对跳过**（归属含糊）。这是尺度告警实际用的判据，也是阈值重量该用的那个。

    `loose=True` 复刻 `scripts/voiceprint-spike.ts` 的 `findMustLinks`（每个 prevLocal
    各配一个 nextLocal）。⚠ 它**不是一一对应**，两个 prevLocal 能同时匹配到同一个
    nextLocal，其中至多一个是真同人；假配对会把尾巴撑肥。**别拿它量阈值**——留在这里
    只为说明两种配对差多少。
    """
    links = []
    for prev, nxt in zip(ws, ws[1:]):
        lo, hi = nxt["startS"], prev["startS"] + prev["durS"]
        if hi - lo <= 1:
            continue
        if loose:
            pc, nc = segs_in_overlap(prev, lo, hi), segs_in_overlap(nxt, lo, hi)
            for pl, ps in pc.items():
                best, best_sum = None, 0.0
                for nl, ns in nc.items():
                    t = sum(max(0.0, min(x[1], y[1]) - max(x[0], y[0])) for x in ps for y in ns)
                    if t > best_sum:
                        best, best_sum = nl, t
                if best:
                    links.append((prev["index"], pl, nxt["index"], best))
            continue

        def dominant(w):
            t = {}
            for s in w["segments"]:
                ov = min(w["startS"] + s["end"], hi) - max(w["startS"] + s["start"], lo)
                if ov > 0:
                    t[s["speaker"]] = t.get(s["speaker"], 0.0) + ov
            order = sorted(t.items(), key=lambda kv: (-kv[1], kv[0]))
            if not order or order[0][1] < 2:
                return None
            if len(order) > 1 and order[1][1] > 0.5 * order[0][1]:
                return None  # 归属含糊
            return order[0][0]

        a, b = dominant(prev), dominant(nxt)
        if a and b:
            links.append((prev["index"], a, nxt["index"], b))
    return links


def pct(xs, q):
    """线性插值分位（type-7），与 scripts/voiceprint-spike.ts 的 p95 同法。"""
    if not xs:
        return float("nan")
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    r = q * (len(s) - 1)
    lo = int(r)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (r - lo)


def describe(name, xs):
    if not xs:
        print(f"  {name:<28} n=0")
        return
    print(f"  {name:<28} n={len(xs):<4} median={pct(xs,.5):.3f}  p95={pct(xs,.95):.3f}  max={max(xs):.3f}")


def cross_window_p05(ws, reps):
    """跨窗全配对距离的 p05——异人下界的**粗代理**（那堆配对里混着同人，所以偏低）。"""
    ds = []
    for a, b in combinations(ws, 2):
        for va in reps[a["index"]].values():
            for vb in reps[b["index"]].values():
                ds.append(1 - cos(va, vb))
    return pct(ds, 0.05), len(ds)


for d in sys.argv[1:]:
    ws = load(d)
    cl = {w["index"]: clean_reps(w) for w in ws}
    fb = {w["index"]: fallback_reps(w) for w in ws}
    n_abst = sum(1 for w in ws for sp in (w.get("speakers") or []) if sp.get("abstained"))
    n_spk = sum(len(w.get("speakers") or []) for w in ws)
    print(f"\n=== {os.path.basename(d)} ===  {len(ws)} 窗，"
          f"窗内说话人 {n_spk}，弃权 {n_abst}（{n_abst/max(n_spk,1):.0%}）")

    for label, loose in (("生产判据（= windowed.ts 的 mustLinkP95：主导者 + 含糊即跳过）", False),
                         ("宽松配对（= spike 脚本的 findMustLinks，仅作对照，别拿它定阈值）", True)):
        links = must_links(ws, loose=loose)
        both, mixed, neither = [], [], []
        for pi, pl, ni, nl in links:
            pc, nc = cl[pi].get(pl), cl[ni].get(nl)
            pf, nf = fb[pi].get(pl), fb[ni].get(nl)
            if pc and nc:
                both.append(1 - cos(pc, nc))
            pe, ne = pc or pf, nc or nf  # 生产实际：有干净代表就用，没有才退回段级均值
            if pe and ne and not (pc and nc):
                (mixed if (pc or nc) else neither).append(1 - cos(pe, ne))
        print(f"\n  -- {label}：{len(links)} 对")
        describe("同口径·两端干净代表", both)
        describe("混口径·一干净一段级", mixed)
        describe("同口径·两端段级均值", neither)
        describe("生产实际（三箱合并）", both + mixed + neither)

    p05, n = cross_window_p05(ws, cl)
    print(f"\n  跨窗全配对 p05（干净代表，异人下界粗代理）: {p05:.3f}  (n={n})")
