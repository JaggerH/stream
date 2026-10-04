import { canonicalJson } from './canonical.ts'

/**
 * 卡住检测（spec §7.2）：**结构化事件的精确相等**，不是文本相似度。能做是因为 `tool_call`
 * 有名有参数。三条判据：同工具同参数连续 N 次；ABAB N 个周期；校验失败连续 N 轮。
 * 判定结果是 `paused`（等人换提示 / 停），不是 error——它在等你，UI 上和「AI 死了」要分得开。
 */
export type StuckVerdict = { stuck: true; why: string; sinceSeq: number } | { stuck: false }

export class StuckDetector {
  private readonly repeats: number
  private readonly cycles: number
  private readonly validationFails: number
  private calls: { seq: number; key: string }[] = []
  private fails: number[] = []

  constructor(opts: { repeats?: number; cycles?: number; validationFails?: number } = {}) {
    this.repeats = opts.repeats ?? 3
    this.cycles = opts.cycles ?? 3
    this.validationFails = opts.validationFails ?? 3
  }

  noteToolCall(seq: number, name: string, rawInput: unknown): StuckVerdict {
    const key = `${name}${canonicalJson(rawInput)}`
    this.calls.push({ seq, key })
    if (this.calls.length > 2 * this.cycles + this.repeats) this.calls = this.calls.slice(-(2 * this.cycles + this.repeats))
    // 同工具同参数连续 N 次
    const tail = this.calls.slice(-this.repeats)
    if (tail.length === this.repeats && tail.every((c) => c.key === key)) {
      return { stuck: true, why: `同一个动作连续 ${this.repeats} 次：${name}`, sinceSeq: tail[0]!.seq }
    }
    // ABAB N 周期
    const n = 2 * this.cycles
    const t2 = this.calls.slice(-n)
    if (t2.length === n && t2[0]!.key !== t2[1]!.key && t2.every((c, i) => c.key === t2[i % 2]!.key)) {
      return { stuck: true, why: `两个动作来回 ${this.cycles} 个周期`, sinceSeq: t2[0]!.seq }
    }
    return { stuck: false }
  }

  noteValidationFail(seq: number): StuckVerdict {
    this.fails.push(seq)
    if (this.fails.length > this.validationFails) this.fails = this.fails.slice(-this.validationFails)
    if (this.fails.length >= this.validationFails) {
      return { stuck: true, why: `校验连续 ${this.validationFails} 轮没过`, sinceSeq: this.fails[this.fails.length - this.validationFails]! }
    }
    return { stuck: false }
  }

  noteValidationOk(): void { this.fails = [] }
  reset(): void { this.calls = []; this.fails = [] }
}
