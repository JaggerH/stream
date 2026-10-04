import { describe, it, expect } from 'vitest'
import {
  dedupeTrack,
  DEFAULT_WATERMARK_MIN_FRAMES,
  DEFAULT_WATERMARK_RATIO,
  type TrackCandidate,
  type DedupeOptions,
} from './dedupe-track.ts'

const frame = (at: number, text: string): TrackCandidate => ({ at, text, kept: true })
const failed = (at: number, text: string): TrackCandidate => ({ at, text, kept: false })

// 规则 1–3 的用例都用一两行的小样本，会被规则 4（行数下限）一起丢掉——那是另一条规则的事。
// 这里显式关掉它，让每个用例只测自己那一条；规则 4 由文件末尾自己的 describe 覆盖。
const dedupe13 = (cs: TrackCandidate[], opts: DedupeOptions = {}) =>
  dedupeTrack(cs, { minLines: 1, ...opts })

describe('dedupeTrack', () => {
  it('同一行跨帧只留第一次出现的那一帧', () => {
    const r = dedupe13([
      frame(0, '第一页要点'),
      frame(5, '第一页要点'),
      frame(10, '第一页要点\n第二页要点'),
    ])
    expect(r.track).toEqual([
      { at: 0, text: '第一页要点' },
      { at: 10, text: '第二页要点' },
    ])
    expect(r.repeatedLines).toBe(2)
  })

  it('出现在够多帧里的行判水印，连第一次也不留', () => {
    // 6 帧，「AI生成」出现在全部 6 帧（比例 1.0 ≥ 0.6），帧数 6 ≥ 下限 5
    const r = dedupe13(
      Array.from({ length: 6 }, (_, i) => frame(i * 10, `AI生成\n第${i}页`)),
    )
    expect(r.watermarkLines).toBe(1)
    expect(r.track.map((t) => t.text)).toEqual(['第0页', '第1页', '第2页', '第3页', '第4页', '第5页'])
    // 水印那 6 行不该同时被记成「重复」——两条规则丢的是不同的东西，账要分得开
    expect(r.repeatedLines).toBe(0)
  })

  it('帧数不到下限时不判水印，只留第一次（一张停留很久的幻灯片不能被整条剔除）', () => {
    const n = DEFAULT_WATERMARK_MIN_FRAMES - 1
    const r = dedupe13(Array.from({ length: n }, (_, i) => frame(i * 10, '唯一那页幻灯片')))
    expect(r.watermarkLines).toBe(0)
    expect(r.track).toEqual([{ at: 0, text: '唯一那页幻灯片' }])
    expect(r.repeatedLines).toBe(n - 1)
  })

  it('出现比例没到门槛就不判水印', () => {
    // 10 帧里出现 5 次 = 0.5 < 0.6
    const r = dedupe13(
      Array.from({ length: 10 }, (_, i) => frame(i * 10, i < 5 ? `半程标题\n第${i}页` : `第${i}页`)),
    )
    expect(DEFAULT_WATERMARK_RATIO).toBeGreaterThan(0.5)
    expect(r.watermarkLines).toBe(0)
    expect(r.track[0]).toEqual({ at: 0, text: '半程标题\n第0页' })
  })

  it('没有内容的行丢掉：纯标点、以及带语言名的 markdown 围栏', () => {
    const r = dedupe13([frame(0, '```markdown\n真正的内容\n```\n———')])
    expect(r.track).toEqual([{ at: 0, text: '真正的内容' }])
    expect(r.emptyLines).toBe(3)
    // 它们不是「重复」，别混进那个数
    expect(r.repeatedLines).toBe(0)
  })

  it('只差标点和大小写的两行算同一行', () => {
    const r = dedupe13([frame(0, '*AI生成*'), frame(5, 'AI 生成。')])
    expect(r.track).toEqual([{ at: 0, text: '*AI生成*' }])
    expect(r.repeatedLines).toBe(1)
  })

  it('一帧的行全被丢光时，整条从轨里消失', () => {
    const r = dedupe13([frame(0, '同一页'), frame(5, '同一页')])
    expect(r.track).toHaveLength(1)
    expect(r.track[0]!.at).toBe(0)
  })

  it('未识别标记原样穿过：两帧同样的报错各留一条，也不参与去重统计', () => {
    const r = dedupe13([
      frame(0, '内容'),
      failed(5, '[未识别：boom]'),
      failed(10, '[未识别：boom]'),
    ])
    expect(r.track).toEqual([
      { at: 0, text: '内容' },
      { at: 5, text: '[未识别：boom]' },
      { at: 10, text: '[未识别：boom]' },
    ])
    expect(r.repeatedLines).toBe(0)
  })

  it('未识别的帧不进水印的分母（否则会把比例稀释到判不出水印）', () => {
    // 5 帧有字、全带水印；再掺 5 帧未识别。若分母算成 10，比例 0.5 < 0.6 就漏判了
    const r = dedupe13([
      ...Array.from({ length: 5 }, (_, i) => frame(i * 10, `台标\n第${i}页`)),
      ...Array.from({ length: 5 }, (_, i) => failed(100 + i * 10, '[未识别：boom]')),
    ])
    expect(r.watermarkLines).toBe(1)
    expect(r.track.filter((t) => t.text.includes('台标'))).toHaveLength(0)
  })

  it('输出保持输入的时间序', () => {
    const r = dedupe13([frame(0, 'a'), failed(1, '[未识别：x]'), frame(2, 'b')])
    expect(r.track.map((t) => t.at)).toEqual([0, 1, 2])
  })

  it('同一帧内重复的行在跨帧频率上只算一次', () => {
    // 5 帧：第 0 帧里「重复行」出现两次，其余 4 帧都没有它。
    // 若按「总出现次数」算，5/5 会误判成水印；按「出现在几帧上」算是 1/5。
    const r = dedupe13([
      frame(0, '重复行\n重复行\n重复行\n重复行\n重复行'),
      ...Array.from({ length: 4 }, (_, i) => frame((i + 1) * 10, `第${i}页`)),
    ])
    expect(r.watermarkLines).toBe(0)
    expect(r.track[0]).toEqual({ at: 0, text: '重复行' })
  })
})

// —— 规则 4：太薄的一帧就是烧录字幕 ——
//
// 实测（2026-08-15，三条真实视频各 27 帧）行数分布是**双峰的，中间几乎没有东西**：
//   抖音财经    1×12, 2×7, 3, 10,10,14,20,21,22,26
//   B站键盘评测  1×5,  2×2, 3,5,6,6,7,7,7,7,7,8,8,8,9,9,9,10,10,11,15,15
//   B站影视飓风  1×20, 2×3, 3,6,8,33
// 1–2 行那一峰全是烧录字幕（「爬坡」「那这次」「NVIDIA」），而字幕转写里本来就有——
// 这一层的定义是「转写拿不到的那部分」，留着它就是把同一句话记两遍。
// ≥3 行那一峰全是真内容（抖音那 8 条正好是 7 张图表 + 1 张卡片，不多不少）。
describe('dedupeTrack — 行数下限（烧录字幕）', () => {
  it('一两行的帧判为字幕，整帧丢掉', () => {
    const r = dedupeTrack([
      frame(0, '爬坡'),
      frame(5, '但英伟达\n一定不会坐视不管'),
      frame(10, '为什么GPU公司开始做CPU？\nAI智能体需要CPU与GPU反复协作\n用户下达任务'),
    ])
    expect(r.track).toEqual([
      { at: 10, text: '为什么GPU公司开始做CPU？\nAI智能体需要CPU与GPU反复协作\n用户下达任务' },
    ])
    expect(r.thinFrames).toBe(2)
  })

  it('恰好 3 行留下——下限是「少于 3 行才丢」', () => {
    const r = dedupeTrack([frame(0, '甲\n乙\n丙')])
    expect(r.track).toHaveLength(1)
    expect(r.thinFrames).toBe(0)
  })

  it('下限可调，调到 1 等于关掉这条规则', () => {
    const r = dedupeTrack([frame(0, '爬坡'), frame(5, '那这次')], { minLines: 1 })
    expect(r.track).toHaveLength(2)
    expect(r.thinFrames).toBe(0)
  })

  // 数的是**去重之后真正会进轨的行**：同一页幻灯片跨帧时，后面那些帧本来就该整帧消失，
  // 不该因为「OCR 原文有 20 行」而被这条规则放行。
  it('数的是去重后剩下的行，不是 OCR 原文的行数', () => {
    const slide = '标题行\n要点一\n要点二\n要点三'
    const r = dedupeTrack([frame(0, slide), frame(5, slide)])
    expect(r.track).toEqual([{ at: 0, text: slide }])
    expect(r.thinFrames).toBe(0) // 第二帧是被规则 3 清空的，不算「太薄」
  })

  // `[未识别：…]` 是「这一帧没跑成」的可见记录，不是画面内容——必须原样穿过去，
  // 否则失败会静静消失，而这一层最怕的就是「没跑」和「跑了没料」分不开。
  it('未识别标记不受行数下限影响', () => {
    const r = dedupeTrack([failed(0, '[未识别：超时]'), frame(5, '爬坡')])
    expect(r.track).toEqual([{ at: 0, text: '[未识别：超时]' }])
  })
})
