import type { StoryFoldStore } from './store.ts'
import { sameStoryInbox, worthChecking, INBOX_PROFILE, type IndexRow, type InboxProfile } from './inbox.ts'
import { textSketch } from '../text/shingle.ts'
import { compareFingerprints } from '../media/audio-fingerprint.ts'
import type { Evidence } from './fold.ts'

/**
 * 归堆的后台工。**判据在这里，不在采集那一跳**——因为判据要文本，而文本可能要转写
 * （实测平均 16s、最慢 142s）。
 *
 * 一轮的形状：
 *   待判队列取一批 → 每条找候选（时长/链接/同期，只缩范围）→ 两边都要有文本
 *   → 没有就去取（正文白拿；音视频排一次转写，这一轮先放它回队列）→ 有了就比文本 → 并/不并
 *
 * **取文本是有代价的，所以只给候选取**：一条 item 没有任何候选，就永远不会被转写。
 */

export interface TextSource {
  /**
   * 拿这条 item 的正文/转写。
   * - 返回文本 → 立刻能判。
   * - 返回 `'pending'` → 已经去取了（排了转写），这一轮判不了，下一轮再说。
   * - 返回 `null` → 这条取不到文本（没有可转写的媒体、或后端没配）。
   */
  textFor(itemId: string): Promise<{ text: string; source: string } | 'pending' | null>
}

export interface StoryFoldWorkerOpts {
  store: StoryFoldStore
  texts: TextSource
  /** 媒体对媒体的判据源（声学指纹）。缺席 = 全部走文本路（今天的行为）。 */
  fps?: import('./fp-source.ts').FpSource
  profile?: InboxProfile
  /** 一轮处理多少条待判。默认 20——每条最多引发两次取文本，够一轮采集的量。 */
  batch?: number
  /** 一条最多被推迟多少轮。到顶就出队：老等一条取不到文本的 item 是纯浪费。 */
  maxAttempts?: number
  /** 候选的时间窗（天）。 */
  windowDays?: number
  /** 被叫醒后隔多久真跑（默认 3s）。一轮采集会连着排几十条，攒一下再跑，别一条一轮。 */
  debounceMs?: number
  /** 兜底巡检间隔（默认 5 分钟）：等文本的条目要靠它回来收尾。 */
  sweepMs?: number
  /** 注入定时器（测试用）。 */
  schedule?: (fn: () => void, ms: number) => void
}

export class StoryFoldWorker {
  private readonly profile: InboxProfile
  private running = false
  private queuedRun = false
  private sweeping = false

  constructor(private readonly opts: StoryFoldWorkerOpts) {
    this.profile = opts.profile ?? INBOX_PROFILE
  }

  private readonly later = (fn: () => void, ms: number) =>
    (this.opts.schedule ?? ((f: () => void, m: number) => { setTimeout(f, m).unref?.() }))(fn, ms)

  /** 刚排进来一批 → 攒一下再跑。**不是每条一轮**：一次采集会连着排几十条。 */
  kick(): void {
    if (this.queuedRun) return
    this.queuedRun = true
    this.later(() => {
      this.queuedRun = false
      void this.runOnce().catch(() => undefined)
    }, this.opts.debounceMs ?? 3_000)
  }

  /**
   * 兜底巡检：等文本的那些条目没人再叫醒它们（转写完成不经过这里），靠这一轮回来收尾。
   * 只启动一次，进程活着就一直转。
   */
  startSweeping(): void {
    if (this.sweeping) return
    this.sweeping = true
    const tick = () => {
      void this.runOnce()
        .catch(() => undefined)
        .finally(() => this.later(tick, this.opts.sweepMs ?? 5 * 60_000))
    }
    this.later(tick, this.opts.sweepMs ?? 5 * 60_000)
  }

  /** 跑一轮。**不并发**：同时两轮会对同一条 item 重复取文本（= 重复计费）。 */
  async runOnce(): Promise<{ processed: number; folded: number; deferred: number }> {
    if (this.running) return { processed: 0, folded: 0, deferred: 0 }
    this.running = true
    const stats = { processed: 0, folded: 0, deferred: 0 }
    try {
      const batch = this.opts.store.pending(this.opts.batch ?? 20, this.opts.maxAttempts ?? 5)
      for (const p of batch) {
        try {
          const outcome = await this.judgeOne(p.itemId)
          stats.processed++
          if (outcome === 'folded') stats.folded++
          if (outcome === 'deferred') stats.deferred++
        } catch (e) {
          // 一条判不动不该让整轮停下——它自己会被 defer，下一轮再来。
          console.error('[story-fold] 判定失败:', (e as Error).message)
          this.opts.store.defer(p.itemId)
        }
      }
    } finally {
      this.running = false
    }
    return stats
  }

  private async judgeOne(itemId: string): Promise<'folded' | 'settled' | 'deferred'> {
    const store = this.opts.store
    const row = store.row(itemId)
    if (!row) {
      store.settle(itemId) // item 的索引没了（重建过账本），没什么可判的
      return 'settled'
    }
    // **已经归过堆就到此为止。** 一对条目里的两条都在队列里，先判的那条已经把它们并了；
    // 后判的那条若再走一遍，会把这一对的"谁先发"记第二次——领先数直接翻倍。
    if (store.membership(itemId)) {
      store.settle(itemId)
      return 'settled'
    }
    const neighbors = store
      .neighbors(row, this.opts.windowDays ?? 14, this.profile.durationToleranceS)
      .filter((n) => worthChecking(row, n, this.profile))
      .filter((n) => !store.vetoed(row.itemId, n.itemId))

    if (neighbors.length === 0) {
      // 没有候选 = 没人可比 —— **绝不为它取文本**。这条是整套成本控制的关键：
      // 转写只花在"疑似重复"的那几条上。
      store.settle(itemId)
      return 'settled'
    }

    let waiting = false
    for (const n of neighbors) {
      let a = store.row(row.itemId)!
      let verdict = sameStoryInbox(a, n, this.profile)
      if (verdict.kind === 'need-text') {
        // 媒体对媒体先走声学指纹：同一份录音判得又准又便宜，且**不为这类对触发转写**
        // （决策见 2026-08-23-audio-fingerprint-fold spec §2）。fp 回 null（非媒体/引擎
        // 不可用/算过但失败）才落回下面的文本路——那条路上 20 分钟闸门照旧看门。
        const fpVerdict = await this.tryFingerprint(row.itemId, n.itemId)
        if (fpVerdict === 'pending') { waiting = true; continue }
        if (fpVerdict === 'different') continue
        if (fpVerdict !== 'no-fp') {
          store.join(row.itemId, n.itemId, [fpVerdict])
          store.recordPair({ streamId: row.streamId, ts: row.ts }, { streamId: n.streamId, ts: n.ts })
          store.settle(itemId)
          return 'folded'
        }
        for (const who of verdict.who) {
          const got = await this.ensureText(who)
          if (got === 'pending') waiting = true
        }
        // 取完再判一次：这一对的文本可能刚好都到位了。
        a = store.row(row.itemId)!
        const fresh = store.row(n.itemId)
        if (!fresh) continue
        verdict = sameStoryInbox(a, fresh, this.profile)
        if (verdict.kind === 'need-text') {
          waiting = true
          continue
        }
      }
      if (verdict.kind === 'same') {
        store.join(row.itemId, n.itemId, [verdict.evidence])
        store.recordPair({ streamId: row.streamId, ts: row.ts }, { streamId: n.streamId, ts: n.ts })
        store.settle(itemId)
        return 'folded'
      }
    }

    // 还有候选在等文本 → 留在队列里；否则这条判完了（结论是"都不是同一条"）。
    if (waiting) {
      store.defer(itemId)
      return 'deferred'
    }
    store.settle(itemId)
    return 'settled'
  }

  /** 确保这条有文本草图。已经有了就什么都不做（**取过一次就不再花第二次钱**）。 */
  private async ensureText(row: IndexRow): Promise<'ready' | 'pending' | 'none'> {
    if (row.textSig?.length) return 'ready'
    const got = await this.opts.texts.textFor(row.itemId)
    if (got === 'pending') return 'pending'
    if (!got) return 'none'
    const sig = textSketch(got.text)
    if (!sig.length) return 'none' // 文本太短，判不了；记不记都一样
    this.opts.store.setText(row.itemId, sig, got.source)
    return 'ready'
  }

  /** 一对条目的指纹裁决。'no-fp' = 这对走不了指纹路（缺源/非媒体），交还文本路。 */
  private async tryFingerprint(aId: string, bId: string): Promise<Evidence | 'pending' | 'different' | 'no-fp'> {
    const fps = this.opts.fps
    if (!fps) return 'no-fp'
    // 先用无副作用的谓词验"这是不是媒体对"：fpFor 会**排队**（跨形态对里给媒体那侧白排
    // 一次 audio-fp = 几百 MB 过网 + 几十秒 CPU，还绕过文本路的 20 分钟闸门）。
    // spec §2 要求跨形态对的行为与改动前一字不差。
    if (!fps.hasFingerprintableMedia(aId) || !fps.hasFingerprintableMedia(bId)) return 'no-fp'
    const [fa, fb] = await Promise.all([fps.fpFor(aId), fps.fpFor(bId)])
    if (fa === 'pending' || fb === 'pending') return 'pending'
    if (!fa || !fb) return 'no-fp'
    const rate = fa.totalS > 0 ? fa.fp.length / fa.totalS : 7
    const r = compareFingerprints(fa.fp, fb.fp, { itemsPerSecond: rate })
    if (!r.match) return 'different'
    return {
      kind: 'audio-identity',
      score: r.similarity,
      detail: `音频指纹吻合：重叠 ${Math.round(r.overlapS / 60)} 分钟，相似度 ${r.similarity.toFixed(2)}（偏移 ${Math.round(r.offsetS)}s）`,
    }
  }
}
