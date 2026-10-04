import { describe, expect, it, vi } from 'vitest'
import type { DiarizedSegment } from './resolve'
import { mergeWindows, mergeWindowsDetailed, type WindowResult } from './windowed'

// ---------------------------------------------------------------------------
// embedding 夹具构造方法：
// 用 4 维单位向量。同一「人」的向量取同一个基向量加微小扰动后归一化——
// 组内 cosine 相似度 ≈ 0.9988（距离 ≈ 0.0012 < 0.1）；不同「人」取正交基向量——
// 组间 cosine 相似度 = 0（距离 = 1 > 0.9）。满足计划要求的组内 <0.1 / 组间 >0.9。
// ---------------------------------------------------------------------------
function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / n)
}
const A = unit([1, 0, 0, 0]) // 说话人甲
const A2 = unit([1, 0.05, 0, 0]) // 甲的另一份采样（组内距离 ≈ 0.0012）
const A3 = unit([1, 0, 0.05, 0]) // 甲的第三份采样
const B = unit([0, 1, 0, 0]) // 说话人乙（与甲距离 = 1）
const B2 = unit([0, 1, 0.05, 0]) // 乙的另一份采样
const C = unit([0, 0, 0, 1]) // 说话人丙（与甲、乙均正交）

// 桥接夹具：甲乙相距 0.36（> 阈值 0.3，是两个人），BRIDGE 落在两人正中、距各自 0.0945。
// 不做锚点过滤时，平均连接会先并碎片与甲，再以 (0.36+0.0945)/2 = 0.227 ≤ 0.3 把乙也并进来——
// 一个 1 秒的碎片就把两个人粘成了一个。
const G1 = unit([1, 0, 0, 0])
const G2 = unit([0.64, 0.76837, 0, 0]) // 与 G1 距离 0.36
const BRIDGE = unit([0.90554, 0.42426, 0, 0]) // 与 G1、G2 各距 0.0945

function seg(start: number, end: number, speaker: string, embedding: number[]): DiarizedSegment {
  return { start, end, speaker, embedding }
}

describe('mergeWindows', () => {
  it('(a) 两窗同一说话人 → 合并成 1 个全局 label，时间正确平移', () => {
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', A)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(5, 15, 'SPEAKER_00', A2)] },
    ]
    const out = mergeWindows(windows)
    expect(out).toHaveLength(2)
    // 时间平移到全局：窗 1 的 [5,15] → [115,125]
    expect(out[0]).toMatchObject({ start: 0, end: 10 })
    expect(out[1]).toMatchObject({ start: 115, end: 125 })
    // 同一全局说话人
    expect(out[0].speaker).toBe('SPEAKER_00')
    expect(out[1].speaker).toBe('SPEAKER_00')
    // 段级 embedding 原样保留
    expect(out[1].embedding).toBe(A2)
  })

  it('(b) 两窗各两人（窗 2 局部 label 对调）→ 4 local 并成 2 全局，跨窗 label 不跳', () => {
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 10, 'SPEAKER_00', A), seg(20, 30, 'SPEAKER_01', B)],
      },
      {
        // 窗内聚类的局部编号与上一窗无关：这里乙先出场拿到 SPEAKER_00
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(10, 20, 'SPEAKER_00', B2), seg(30, 40, 'SPEAKER_01', A2)],
      },
    ]
    const out = mergeWindows(windows)
    expect(out).toHaveLength(4)
    const labels = new Set(out.map((s) => s.speaker))
    expect(labels.size).toBe(2)
    // 甲的两段（首窗 [0,10] 与次窗全局 [140,150]）同一全局 label；乙同理
    const byStart = new Map(out.map((s) => [s.start, s.speaker]))
    expect(byStart.get(0)).toBe(byStart.get(140)) // 甲
    expect(byStart.get(20)).toBe(byStart.get(120)) // 乙
    expect(byStart.get(0)).not.toBe(byStart.get(20))
    // 首窗按出场序定全局编号：甲=00、乙=01
    expect(byStart.get(0)).toBe('SPEAKER_00')
    expect(byStart.get(20)).toBe('SPEAKER_01')
  })

  // 三份采样来自同一个人，但两两距离不均匀（真实数据里很常见：中间那份录得偏）：
  //   d(P1,P2)=0.35  d(P1,P3)=0.10  d(P2,P3)≈0.084
  // 一遍过贪心按窗序处理：P2 与 P1 距离 0.35 > 阈值 → 被迫新开一个全局；
  // 之后 P3 更靠近 P2，并进了那个"新开的"，于是同一个人留下两个全局说话人。
  // 全局平均连接看得到全部三份：先并最近的 P2-P3，再看 {P2,P3} 与 P1 的平均距离
  // ((0.35+0.10)/2 = 0.225 ≤ 0.3) → 三份归一个人。
  const P1 = unit([1, 0, 0, 0])
  const P2 = unit([0.65, 0.7599342, 0, 0]) // 与 P1 距离 0.35
  const P3 = unit([0.9, 0.4358899, 0, 0]) // 与 P1 距离 0.10、与 P2 距离 ≈0.084

  it('(c1) 同一个人被窗序拆开时，全局视角能救回来（贪心救不回）', () => {
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', P1)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', P2)] },
      { index: 2, startS: 220, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', P3)] },
    ]
    const out = mergeWindows(windows, { threshold: 0.3 })
    expect(out).toHaveLength(3)
    expect(new Set(out.map((s) => s.speaker)).size).toBe(1)
  })

  it('(c) 同窗两个 local 向量足够近时会并成一个人（放弃 app.py 的同窗硬约束）', () => {
    // 容器会把一个人连续讲满一窗判成"主说话人 + 几个碎片"。硬约束会把这些碎片
    // 永久钉死在不同的全局说话人上，正是要治的病，所以有意放弃。
    const single = mergeWindows([
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 10, 'SPEAKER_00', A), seg(20, 30, 'SPEAKER_01', A2)],
      },
    ])
    expect(new Set(single.map((s) => s.speaker)).size).toBe(1)

    // 但"近"仍受阈值管：同窗两个正交的 local 照样是两个人
    const two = mergeWindows([
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 10, 'SPEAKER_00', A), seg(20, 30, 'SPEAKER_01', B)],
      },
    ])
    expect(new Set(two.map((s) => s.speaker)).size).toBe(2)
  })

  it('(c2) 不足 3 秒的碎片不参与决定簇结构：不能把两个人粘成一个', () => {
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', G1)] },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', G2), seg(70, 71, 'SPEAKER_01', BRIDGE)],
      },
    ]
    const out = mergeWindows(windows, { threshold: 0.3 })
    const labels = new Set(out.map((s) => s.speaker))
    expect(labels.size).toBe(2)
    // 两个锚点必须各是各的人——碎片没能把他们粘成一个
    const g1 = out.find((s) => s.start === 0)!
    const g2 = out.find((s) => s.start === 110)!
    expect(g1.speaker).not.toBe(g2.speaker)
  })

  it('(c3) 碎片离所有簇都远 → 单独成簇，不被硬塞给谁', () => {
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A)] },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', A2), seg(70, 71, 'SPEAKER_01', C)],
      },
    ]
    const out = mergeWindows(windows, { threshold: 0.25 })
    const labels = new Set(out.map((s) => s.speaker))
    expect(labels.size).toBe(2)
    // 碎片自己一簇，不改变甲的归属
    const frag = out.find((s) => s.start === 180)!
    const main = out.find((s) => s.start === 0)!
    expect(frag.speaker).not.toBe(main.speaker)
  })

  it('(d) 重叠区双出 segment 只留一份，归属按中点', () => {
    // 窗 0 覆盖 [0,120]、窗 1 覆盖 [110,230] → 重叠区 [110,120]，分界 = 115（重叠区中点）
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [
          seg(0, 10, 'SPEAKER_00', A),
          seg(111, 113, 'SPEAKER_00', A2), // 全局 [111,113] 中点 112 < 115 → 归窗 0
          seg(116, 119, 'SPEAKER_00', A2), // 全局 [116,119] 中点 117.5 ≥ 115 → 该由窗 1 出，此份丢弃
        ],
      },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [
          seg(1, 3, 'SPEAKER_00', A2), // 全局 [111,113] 中点 112 < 115 → 窗 0 已出，此份丢弃
          seg(6, 9, 'SPEAKER_00', A3), // 全局 [116,119] 中点 117.5 ≥ 115 → 归窗 1
          seg(50, 60, 'SPEAKER_00', A),
        ],
      },
    ]
    const out = mergeWindows(windows)
    // [111,113] 与 [116,119] 各只出一份
    expect(out.map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [111, 113],
      [116, 119],
      [160, 170],
    ])
    // 归属核对：[111,113] 带窗 0 的 embedding，[116,119] 带窗 1 的
    expect(out[1].embedding).toBe(A2)
    expect(out[2].embedding).toBe(A3)
    expect(new Set(out.map((s) => s.speaker)).size).toBe(1)
  })

  it('(e) 单窗输入 → 原样透传（时间平移为 0）', () => {
    const segs = [seg(0, 5, 'SPEAKER_00', A), seg(10, 15, 'SPEAKER_01', B), seg(20, 25, 'SPEAKER_00', A2)]
    const out = mergeWindows([{ index: 0, startS: 0, durS: 120, segments: segs }])
    expect(out.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [10, 15],
      [20, 25],
    ])
    expect(out.map((s) => s.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00'])
    expect(out[0].embedding).toBe(A)
  })

  it('(f) 代表=时长加权单位均值：最长段偏了、但均值仍近 → 并入（非最长单段语义）', () => {
    // 真实数据教训(E19 实测):同人跨话语的单段 embedding 距离 p95≈0.5,单取最长段当代表
    // 一次采样偏了就整窗领新号(47min 一集 69 个"全局说话人")。加权均值把偏差平均掉。
    // farVec 与 A 的 cosine=0.4 → 距离 0.6 > 0.5:最长段(6s)单独当代表必然并不上;
    // 与 4s 的 A 加权平均后 cosine≈0.759 → 距离≈0.241 ≤ 0.5:均值代表应并上。
    const farVec = unit([0.4, Math.sqrt(1 - 0.16), 0, 0])
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', A)] },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(10, 16, 'SPEAKER_00', farVec), seg(30, 34, 'SPEAKER_00', A)],
      },
    ]
    const out = mergeWindows(windows)
    expect(out).toHaveLength(3)
    expect(new Set(out.map((s) => s.speaker)).size).toBe(1)
    expect(out.every((s) => s.speaker === 'SPEAKER_00')).toBe(true)
  })

  it('(g) 均值代表跳过零向量段：混入零向量不再拖垮整个 local', () => {
    // 旧语义:最长段恰是零向量 → 代表取不出 → 该 local 全部 segments 丢弃。
    // 新语义:零向量不进均值,还有有效段就能出代表——只有全零才丢。
    const zero = [0, 0, 0, 0]
    const out = mergeWindows([
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', A)] },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(10, 20, 'SPEAKER_00', zero), seg(30, 35, 'SPEAKER_00', A2)],
      },
    ])
    expect(out).toHaveLength(3) // 零向量段本身仍保留在输出里(它只是不进代表)
    expect(new Set(out.map((s) => s.speaker)).size).toBe(1)
  })

  it('(h) 某 local 全部段零时长(weight=0) → 仍丢弃,但打一行 warn(含 item/窗口/local/段数)', () => {
    // 加权均值改动的假想敌:某 local 在窗内全部段 start===end,embedding 非零、
    // normalizeToUnit 能算出 sum,但 weight 恒为 0 → emb 落 null 分支被整窗丢弃。
    // 拍板:丢弃行为不变,只让"静默丢弃"变"有痕丢弃"。断言:该 local 段全不出,warn 被调一次。
    const warn = vi.fn()
    const out = mergeWindows(
      [
        {
          index: 3,
          startS: 0,
          durS: 120,
          segments: [
            seg(5, 5, 'SPEAKER_00', A), // 零时长、embedding 非零 → 进 sum 但 weight 不增
            seg(8, 8, 'SPEAKER_00', A2), // 同上,该 local 全部段零时长
            seg(20, 30, 'SPEAKER_01', B), // 正常段,不受影响
          ],
        },
      ],
      { itemId: 'item-x', warn },
    )
    // SPEAKER_00 的两段被丢弃,只剩 SPEAKER_01 的一段(丢弃行为不变)
    expect(out.map((s) => [s.start, s.end])).toEqual([[20, 30]])
    // warn 打了一行,含 item / 窗口 index / local speaker id / 段数
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0][0] as string
    expect(msg).toContain('item-x')
    expect(msg).toContain('3') // 窗口 index
    expect(msg).toContain('SPEAKER_00') // local speaker id
    expect(msg).toContain('2') // 段数
  })

  it('(c4) 默认阈值是 0.25：距离 0.35 的两份采样默认不再被并成一个人', () => {
    // 0.5 那把旧刀会把它们并掉；0.25 不会。钉住默认值本身。
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', P1)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', P2)] },
    ]
    expect(new Set(mergeWindows(windows).map((s) => s.speaker)).size).toBe(2)
    expect(new Set(mergeWindows(windows, { threshold: 0.5 }).map((s) => s.speaker)).size).toBe(1)
  })

  it('(c5) 代表数超上限 → 退回贪心并 warn，不炸', () => {
    const warn = vi.fn()
    // 造 2001 个窗，每窗一个 local：代表数 2001 > MAX_REPS
    const windows: WindowResult[] = []
    for (let i = 0; i < 2001; i++) {
      windows.push({
        index: i,
        startS: i * 110,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', i % 2 === 0 ? A : B)],
      })
    }
    const out = mergeWindows(windows, { warn })
    expect(out).toHaveLength(2001)
    expect(new Set(out.map((s) => s.speaker)).size).toBe(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('代表数'))
  })

  it('(c8) 有容器给的干净代表就用它，别拿一堆短段求平均', () => {
    // 容器会把该说话人的若干段音频**拼起来**（≤20s）重算一个代表；段级 embedding 各自只摊到
    // 两三秒音频，求平均抹不掉「每段太少」这个根子（块长实测：≥8s 才存在可用刀口）。
    // 这里造的形状：两窗是同一个人，但段级 embedding 被噪声推到彼此正交（求平均必然分成两人），
    // 而容器给的干净代表一致 → 用干净代表就并成一个人。
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', A)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', B)], // 与 A 正交
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
    ]
    expect(new Set(mergeWindows(windows).map((s) => s.speaker)).size).toBe(1)
    // 没有 speakers 的老窗（断点续跑存下来的）照旧走段级加权均值 —— A ⊥ B 分成两人
    const legacy = windows.map((w) => ({ ...w, speakers: undefined }))
    expect(new Set(mergeWindows(legacy).map((s) => s.speaker)).size).toBe(2)
  })

  it('(c9) 被门控判弃权的说话人不当锚点——但它的段一秒不少', () => {
    // 容器的帧级门控看过音频后说「这段回答不了『这是谁』」（`abstained: true` + 空 embedding）。
    // 此时**不能**退回段级均值当锚点：段级均值来自同一段脏音频，退回去等于把刚拦下的东西放回来。
    // 弃权者降级成碎片：可以就近归附、可以自成一组，但不许参与决定「有哪些人」。
    const win = (index: number, emb: number[], abstained: boolean): WindowResult => ({
      index,
      startS: index * 110,
      durS: 120,
      segments: [seg(0, 60, 'SPEAKER_00', emb)],
      speakers: [
        abstained
          ? { speaker: 'SPEAKER_00', embedding: [], clipSeconds: 0, abstained: true, gatedSeconds: 2 }
          : { speaker: 'SPEAKER_00', embedding: emb, clipSeconds: 20 },
      ],
    })

    // 窗 0/1 是同一个人(A)、都不弃权 → 一个簇。窗 2 的段级向量与 A 正交(B)且被判弃权：
    // 它不许开新簇当锚点，只能就近归附 —— 但 B ⊥ A 距离 1.0 远超阈值，所以自成一组。
    const out = mergeWindows([win(0, A, false), win(1, A2, false), win(2, B, true)])
    expect(out).toHaveLength(3)
    const labels = out.map((s) => s.speaker)
    expect(labels[0]).toBe(labels[1]) // 两窗的 A 并成一个人
    expect(labels[2]).not.toBe(labels[0]) // 弃权者没被硬塞进别人名下

    // 关键对照：**同样的输入、只是不标弃权** → 那个 B 会当锚点开簇。两种情况簇数都是 2，
    // 区别在于弃权者进的是「碎片归附」那条路、进不了质心，影响不了别人是谁。
    const notAbstained = [win(0, A, false), win(1, A2, false), win(2, B, false)]
    expect(new Set(mergeWindows(notAbstained).map((s) => s.speaker)).size).toBe(2)

    // 弃权者若与已有簇足够近，就并进去而不是自成一组（问路可以，贡献指纹不行）
    const near = mergeWindows([win(0, A, false), win(1, A2, false), win(2, A3, true)])
    expect(new Set(near.map((s) => s.speaker)).size).toBe(1)
  })

  it('(c10) 弃权 ≠ 缺省：整窗没给 speakers 的老容器仍走段级均值', () => {
    // 这条守的是「别把两种情况合并处理」。缺省 = 没人算过干净代表（老容器/关了二次归组），
    // 退回段级均值是对的；弃权 = 容器看过音频后拒绝作答，退回去就错了。(c9) 管后者，这条管前者。
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', B)] },
    ]
    // A ⊥ B，段级均值各自成簇 —— 没有任何一方被当成弃权而降级
    expect(new Set(mergeWindows(windows).map((s) => s.speaker)).size).toBe(2)
  })

  it('(c6) 确定性：同一份输入跑两次，结果逐段相同', () => {
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A), seg(70, 90, 'SPEAKER_01', B)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', B2), seg(70, 90, 'SPEAKER_01', A2)] },
      { index: 2, startS: 220, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A3), seg(70, 71, 'SPEAKER_01', C)] },
    ]
    expect(mergeWindows(windows)).toEqual(mergeWindows(windows))
  })

  it('(c7) 输入窗的数组顺序不影响结果（排序按 index，不按数组位置）', () => {
    const mk = (): WindowResult[] => [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A), seg(70, 90, 'SPEAKER_01', B)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', B2), seg(70, 90, 'SPEAKER_01', A2)] },
      { index: 2, startS: 220, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A3), seg(70, 71, 'SPEAKER_01', C)] },
    ]
    const inOrder = mergeWindows(mk())
    const shuffled = mk()
    const reordered = [shuffled[2], shuffled[0], shuffled[1]]
    expect(mergeWindows(reordered)).toEqual(inOrder)
  })

  it('容错：空输入与无 segments 的窗不炸、不影响其余窗', () => {
    expect(mergeWindows([])).toEqual([])
    const out = mergeWindows([
      { index: 0, startS: 0, durS: 120, segments: [] },
      { index: 1, startS: 110, durS: 120, segments: [seg(20, 30, 'SPEAKER_00', A)] },
    ])
    expect(out).toEqual([{ start: 130, end: 140, speaker: 'SPEAKER_00', embedding: A }])
  })
})

// ---------------------------------------------------------------------------
// 库用簇代表（`mergeWindowsDetailed().clusterReps`）
//
// 门控只惠及跨窗合并那条路时，声纹库拿的仍是段级均值（脏段照进）——前门装了闸、后门敞着。
// 这一组守的是「存进 registry 的簇代表由容器门控后的干净代表聚出」，以及它的边界：
// 弃权者不进、老窗的段级均值不进（不混口径）、一个干净代表都没有时干脆缺省（让调用方兜底）。
// ---------------------------------------------------------------------------
describe('mergeWindowsDetailed — 库用簇代表由干净代表聚出', () => {
  const cos = (a: number[], b: number[]): number => {
    let d = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      d += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return d / Math.sqrt(na * nb)
  }
  /** 与 C 相距 0.042 的「脏」向量：够近，能被归附进 C 的簇；够远，混进代表就看得出来。 */
  const DIRTY_NEAR_C = unit([0, 0, 0.3, 1])

  it('(r1) 同一全局簇下各窗的干净代表聚成库用代表——段级均值不参与', () => {
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', A)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', B)], // 与 A 正交：段级均值会落在 A、B 之间，绝不是 C
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
    ]
    const { segments, clusterReps } = mergeWindowsDetailed(windows)
    expect(new Set(segments.map((s) => s.speaker)).size).toBe(1)
    const rep = clusterReps.get('SPEAKER_00')!
    expect(rep).toBeTruthy()
    expect(cos(rep, C)).toBeGreaterThan(0.9999)
  })

  it('(r2) 按各自实际发言秒数加权：讲得多的那一窗主导库用代表', () => {
    // 两窗是同一个人的两份干净代表，相距 0.1（cos 0.9，同簇）。加权后必然偏向时长长的一侧。
    const P = unit([1, 0, 0, 0])
    const Q = unit([0.9, Math.sqrt(1 - 0.81), 0, 0]) // cos(P,Q) = 0.9
    const mk = (durLong: number, durShort: number): WindowResult[] => [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, durLong, 'SPEAKER_00', P)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: P, clipSeconds: 20 }],
      },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(0, durShort, 'SPEAKER_00', Q)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: Q, clipSeconds: 20 }],
      },
    ]
    const heavyP = mergeWindowsDetailed(mk(60, 4)).clusterReps.get('SPEAKER_00')!
    expect(cos(heavyP, P)).toBeGreaterThan(cos(heavyP, Q))
    const heavyQ = mergeWindowsDetailed(mk(4, 60)).clusterReps.get('SPEAKER_00')!
    expect(cos(heavyQ, Q)).toBeGreaterThan(cos(heavyQ, P))
  })

  it('(r3) 弃权者的脏音频不进库用代表——门控在库这一侧同样有效', () => {
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', C)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
      {
        index: 1,
        startS: 110,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', C)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
      {
        // 弃权：容器看过音频后拒绝作答。它的段级向量够近会被归附进同一个簇（时间线不动），
        // 但那份脏向量绝不能进库用代表。
        index: 2,
        startS: 220,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', DIRTY_NEAR_C)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: [], clipSeconds: 0, abstained: true, gatedSeconds: 2 }],
      },
    ]
    const { segments, clusterReps } = mergeWindowsDetailed(windows)
    expect(new Set(segments.map((s) => s.speaker)).size).toBe(1) // 弃权者归附进来了，段一秒没少
    expect(segments).toHaveLength(3)
    const rep = clusterReps.get('SPEAKER_00')!
    expect(cos(rep, C)).toBeGreaterThan(0.9999) // 一点没被 DIRTY 拉走
  })

  it('(r4) 不混口径：同簇里没有干净代表的老窗，其段级均值也不进库用代表', () => {
    // 「只能在同一种代表口径之间比距离」这条教训的落点——库用代表也一样，一个簇的代表
    // 要么整份由干净代表聚出，要么整份退回段级均值，绝不半干净半脏地拌在一起。
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', C)],
        speakers: [{ speaker: 'SPEAKER_00', embedding: C, clipSeconds: 20 }],
      },
      // 老容器 / 断点续跑存下来的老窗：没有 speakers，走段级均值参与合并
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', DIRTY_NEAR_C)] },
    ]
    const { segments, clusterReps } = mergeWindowsDetailed(windows)
    expect(new Set(segments.map((s) => s.speaker)).size).toBe(1)
    expect(cos(clusterReps.get('SPEAKER_00')!, C)).toBeGreaterThan(0.9999)
  })

  it('(r5) 一个干净代表都没有的簇缺省——由调用方退回段级均值，不在这里编一个', () => {
    const windows: WindowResult[] = [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A)] },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', B)] },
    ]
    const { segments, clusterReps } = mergeWindowsDetailed(windows)
    expect(new Set(segments.map((s) => s.speaker)).size).toBe(2)
    expect(clusterReps.size).toBe(0)
  })

  it('(r6) mergeWindows 与 mergeWindowsDetailed().segments 逐段相同（时间线不因这层改动而变）', () => {
    const windows: WindowResult[] = [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 60, 'SPEAKER_00', A), seg(70, 90, 'SPEAKER_01', B)],
        speakers: [
          { speaker: 'SPEAKER_00', embedding: A, clipSeconds: 20 },
          { speaker: 'SPEAKER_01', embedding: B, clipSeconds: 20 },
        ],
      },
      { index: 1, startS: 110, durS: 120, segments: [seg(0, 60, 'SPEAKER_00', A2)] },
    ]
    expect(mergeWindowsDetailed(windows).segments).toEqual(mergeWindows(windows))
  })
})

describe('mergeWindows — 去共享成分（removeSharedComponent）', () => {
  // 「罐头笑声」建模：两个本来正交的说话人，各自嵌入上叠加同一个**大的共享偏移**。
  // 叠加后两人方向被拉得几乎一致（基线必并），减掉共享成分后残差反向（必分）。
  const SHARED = [5, 5, 0, 0]
  const add = (v: number[], o: number[]) => v.map((x, i) => x + o[i])
  const spk1 = add([1, 0, 0, 0], SHARED) // [6,5,0,0]
  const spk2 = add([0, 1, 0, 0], SHARED) // [5,6,0,0]
  // 两窗不重叠，避开重叠去重，专测合并判定
  const windows = (): WindowResult[] => [
    { index: 0, startS: 0, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', spk1)] },
    { index: 1, startS: 120, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', spk2)] },
  ]
  const labels = (segs: DiarizedSegment[]) => new Set(segs.map((s) => s.speaker))

  it('基线把两个被共享成分污染的说话人并成一个（复现 bug）', () => {
    // 显式关掉去共性：这条测的是「不去共性就会并错」，不能靠默认值表达——Task 5 翻默认后
    // 靠默认的写法会莫名变红，且它测的东西会在无人察觉时变成另一回事。
    const out = mergeWindows(windows(), { threshold: 0.5, removeSharedComponent: false })
    expect(out).toHaveLength(2)
    expect(labels(out).size).toBe(1) // 两个不同的人 → 同一个 label，正是要治的病
  })

  it('去共享成分后两人分开', () => {
    const out = mergeWindows(windows(), { threshold: 0.5, removeSharedComponent: true })
    expect(out).toHaveLength(2)
    expect(labels(out).size).toBe(2)
  })

  it('干净数据（无共享污染、非正交非对称）上，去共性不改变划分——别把本来好的弄坏', () => {
    // 上一版夹具用互相正交的基向量（A=e1,B=e2,C=e4）：对任意 n 个正交单位向量，
    // 均值居中后 (v_i-mean)·(v_j-mean) = -1/n、|v_i-mean|=sqrt(1-1/n) 是精确闭式，
    // 居中后任意两人的 cosine 恒为 -1/(n-1)——n=2 时恒为 -1（正好反向），n=3 时恒为
    // -0.5，这个值只由 n 和"正交+对称"这个几何巧合决定，跟 globalMeanEmbedding
    // 有没有算对（少加一段、权重错、越界写）完全无关：实现哪怕算错了均值，只要还
    // 大致落在对称位置，闭式仍会让测试通过。这不是"划分不变"的有效证据。
    //
    // 本夹具改用三个两两夹角互不相等、也不对称的方向（无正交、无置换对称），
    // 迫使"居中后仍是同一划分"依赖 globalMeanEmbedding 算对，而非几何巧合：
    //   D1=unit([1,0,0,0]) D2=unit([2,3,0,0]) D3=unit([1,1,3,0])
    //   raw cos(D1,D2)=0.5547 cos(D1,D3)=0.3015 cos(D2,D3)=0.4181 ——三个都不同。
    // 每个说话人跨 2 个窗出现、且窗内段时长不等（4s/8s、7s/2s、3s/9s），
    // 顺带覆盖代表向量的时长加权均值这条与 globalMean 的无权重均值不同的路径。
    // 实测（脚本 tmp/compute.mjs，对本夹具真实向量算的，非闭式代入）：
    //   居中前不同说话人窗代表两两距离：P-Q=0.4369 P-R=0.6699 Q-R=0.5543
    //   居中后同一批距离             ：P-Q=1.3363 P-R=1.6376 Q-R=1.5108
    //   同一说话人跨窗代表距离（应保持很小、必并）：
    //     居中前 P-P=0.00033 Q-Q=0.00008 R-R=0.00031
    //     居中后 P-P=0.00055 Q-Q=0.00014 R-R=0.00065
    // 三条互不相等,且没有代数上必然如此的理由——threshold=0.35 稳稳卡在
    // "组内 <0.001" 与 "组间 >0.43" 之间,居中前后都成立,划分不变是真断言。
    const D1 = unit([1, 0, 0, 0])
    const D2 = unit([2, 3, 0, 0])
    const D3 = unit([1, 1, 3, 0])
    const P1 = add(D1, [0, 0.03, 0, 0]) // P：窗0 段a dur=4
    const P2 = add(D1, [0, 0, 0.02, 0]) // P：窗0 段b dur=8
    const P3 = add(D1, [0.01, 0, 0, 0.02]) // P：窗3 单段 dur=6
    const Q1 = add(D2, [0, 0, 0.02, 0]) // Q：窗1 单段 dur=5
    const Q2 = add(D2, [0.02, 0, 0, 0]) // Q：窗4 段a dur=3
    const Q3 = add(D2, [0, 0.01, 0.01, 0]) // Q：窗4 段b dur=9
    const R1 = add(D3, [0.02, 0, 0, 0]) // R：窗2 段a dur=7
    const R2 = add(D3, [0, 0.02, 0, 0]) // R：窗2 段b dur=2
    const R3 = add(D3, [0, 0, 0, 0.02]) // R：窗5 单段 dur=5
    const clean = (): WindowResult[] => [
      {
        index: 0,
        startS: 0,
        durS: 120,
        segments: [seg(0, 4, 'SPEAKER_00', P1), seg(4, 12, 'SPEAKER_00', P2)],
      },
      { index: 1, startS: 120, durS: 120, segments: [seg(0, 5, 'SPEAKER_00', Q1)] },
      {
        index: 2,
        startS: 240,
        durS: 120,
        segments: [seg(0, 7, 'SPEAKER_00', R1), seg(7, 9, 'SPEAKER_00', R2)],
      },
      { index: 3, startS: 360, durS: 120, segments: [seg(0, 6, 'SPEAKER_00', P3)] },
      {
        index: 4,
        startS: 480,
        durS: 120,
        segments: [seg(0, 3, 'SPEAKER_00', Q2), seg(3, 12, 'SPEAKER_00', Q3)],
      },
      { index: 5, startS: 600, durS: 120, segments: [seg(0, 5, 'SPEAKER_00', R3)] },
    ]
    const base = mergeWindows(clean(), { threshold: 0.35, removeSharedComponent: false })
    const centered = mergeWindows(clean(), { threshold: 0.35, removeSharedComponent: true })
    expect(labels(base).size).toBe(3)
    expect(labels(centered).size).toBe(3) // 同样的划分：说话人数不变
    // 同样的划分：每一段在 base 与 centered 下拿到的全局 label 集合形状一致
    // （按出场序对应的 start 时间戳分组，看是否每人仍各自独立成簇）
    const groupByStart = (segs: DiarizedSegment[]) => {
      const byLabel = new Map<string, number[]>()
      for (const s of segs) {
        const arr = byLabel.get(s.speaker) ?? []
        arr.push(s.start)
        byLabel.set(s.speaker, arr)
      }
      return new Set([...byLabel.values()].map((starts) => starts.sort().join(',')))
    }
    expect(groupByStart(centered)).toEqual(groupByStart(base))
  })

  it('零向量段不参与共享成分估计，也不改变划分（判零在 centering 之前）', () => {
    const withZero = (): WindowResult[] => [
      { index: 0, startS: 0, durS: 120, segments: [seg(0, 10, 'SPEAKER_00', spk1)] },
      {
        index: 1,
        startS: 120,
        durS: 120,
        // 同一个 local 里混进一个全零段：它必须既不进均值、也不影响聚类结果
        segments: [seg(0, 10, 'SPEAKER_00', spk2), seg(10, 11, 'SPEAKER_00', [0, 0, 0, 0])],
      },
    ]
    const out = mergeWindows(withZero(), { threshold: 0.5, removeSharedComponent: true })
    expect(labels(out).size).toBe(2) // 与不含零段时一致
    expect(out).toHaveLength(3) // 零段本身仍随 local 输出（既有语义）
  })

  it('确定性：同输入两次运行结果一致', () => {
    const a = mergeWindows(windows(), { threshold: 0.5, removeSharedComponent: true })
    const b = mergeWindows(windows(), { threshold: 0.5, removeSharedComponent: true })
    expect(a).toEqual(b)
  })
})
