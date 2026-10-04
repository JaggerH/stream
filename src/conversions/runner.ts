// src/conversions/runner.ts
//
// 所有「把 item 转成产物」的共享底座：排队、去重、取消、重启孤儿清理、可重试失败的延迟重排，
// 以及**分阶段计时**。每种转换只提供两件事——怎么跑一次、声明哪些阶段——其余全在这里，写一份。
//
// 这是本次重构的核心：在此之前 docparse 和 transcribe 各自抄了一份这套逻辑，导致 transcribe 后来
// 长出的能力（延迟重排、账本、事件）docparse 一个都没有，而计时要加两遍。设计见
// docs/superpowers/specs/2026-07-25-conversions-unified-api-design.md。
import type { TranscriptSegment } from '../transcribe/client.ts'
// 「哪条 extract 是转写」这条判据前后端同吃一份（前端详情页的转写档也要挑同一条记录）。
import { pickTranscript, segmentsIn } from '../../shared/extract/transcript.ts'
import { ladderOf, type LadderTrace } from '../providers/ladder-trace.ts'
import type {
  ConversionError,
  ConversionKind,
  ConversionRecord,
  ConversionSnapshot,
  ConversionStage,
  ConversionStore,
  ListConversionsQuery,
} from './store.ts'
import { derivationsFor, costartsFor, type DerivationRule, type CostartRule } from './derive.ts'

/** 转换跑一次的产物：成功带 result，失败带结构化 error。
 *  `retryable` 是「现在不行，等会儿就行」——例如 standby 后端还在装权重。任务层据此延迟重排整条
 *  转换，而不是判死（意图未了结，记录停在 queued）。 */
export type ConversionOutcome =
  | { ok: true; result: unknown; ladder?: LadderTrace }
  | { ok: false; error: ConversionError; retryable?: boolean; ladder?: LadderTrace }

export interface ConversionContext {
  id: string
  itemId: string
  kind: ConversionKind
  inputId?: string
  options: Record<string, unknown>
  signal: AbortSignal
  /** 该次转换的中间产物目录（仅接了账本时有）——分窗断点续跑的窗文件写在这里，
   *  转换成功收尾时随账本行一起回收。 */
  jobDir?: string
  /** 把一段活儿包成一个计时阶段。**只有真的跑过的阶段才会进 timing**——没跑过的不出现，
   *  而不是记成 0ms（「没跑」和「跑了 0ms」必须可区分）。 */
  stage<T>(name: string, fn: () => Promise<T>): Promise<T>
}

export interface Converter {
  kind: ConversionKind
  label: string
  /** 声明的阶段名（供 /api/conversion-kinds 展示）；实际记录的以 ctx.stage 真跑过的为准。 */
  stages: string[]
  /** 该 kind 的后端此刻配没配。前端据此决定按钮显不显示，不必 POST 试探 503。 */
  available: () => boolean
  /** 可接受的 options 形状描述（纯展示用，如 { diarize: 'boolean' }）。 */
  options?: Record<string, string>
  /** 该 kind 内部各分支此刻配没配（只有 extract 有分支）。kind 级的 `available` 回答不了
   *  「这条 item 行不行」——那是 per-item 的，取决于它是图还是视频；前端拿这份表 + item 自己的
   *  archetype 一映射就知道，不必为每条 item 打一发请求。 */
  branches?: () => Record<string, boolean>
  run(ctx: ConversionContext): Promise<ConversionOutcome>
}

export interface ConversionRunnerDeps {
  store: ConversionStore
  converters: Converter[]
  /** 同时在跑的转换数。默认 1——转写/OCR 都是重活，本来就一次一个。 */
  maxConcurrent?: number
  /** 可重试失败的重排策略。`max` = 重排上限（默认 2 → 连首次共 3 次）；`delayMs` = 间隔（默认 30s）。 */
  retry?: { max?: number; delayMs?: number }
  /** 注入的定时器（默认 setTimeout().unref()，测试注入捕获版）。 */
  schedule?: (fn: () => void, ms: number) => void
  /** 注入的时钟（默认 Date.now，测试注入可控版）。计时全走它。 */
  now?: () => number
  /** 转换落定（done / error）时回调一次——事件层（通知中心）的接入点。取消与延迟重排不算落定。 */
  onSettled?: (rec: ConversionRecord) => void
  /** capability job 账本（可选）：排队 enqueue、起跑 markRunning、成功/取消 complete、失败 fail。
   *  重构前只有 transcribe 接了它（docparse 崩了就是崩了）；收进 runner 后所有 kind 一起拥有。
   *  同时它提供每个 job 的中间产物目录（ctx.jobDir），分窗断点续跑的窗文件挂在那里。 */
  ledger?: ConversionLedger
  /** 一条转换成功落定后自动排出的下一层（`derive.ts` 的规则表）。
   *
   *  **必填，不是可选**：漏接线的表现是「什么都不发生」——没有报错、没有日志、没有记录，
   *  只是说话人永远不会被自动补上。这种失败必须在 typecheck 就炸，不能留到活体上靠人发现。
   *  不想派生就显式传 `[]`。 */
  derivations: readonly DerivationRule[]
  /** 起一条转换时**同时**要起的那些（`derive.ts` 的并肩规则表）。
   *
   *  同样必填、同样是因为漏接线什么都不会发生：串行照跑，只是永远不并行，没有一处会喊。
   *  不想并肩就显式传 `[]`。 */
  costarts: readonly CostartRule[]
}

/** 账本的最小接口——只取 runner 用得着的那几个方法，避免把 CapabilityJobStore 整个类型绑死。 */
export interface ConversionLedger {
  enqueue(kind: string, input: Record<string, unknown>): string
  markRunning(jobId: string): void
  complete(jobId: string): void
  fail(jobId: string, error: string): void
  jobDirOf(jobId: string): string
  /** 上个进程留下的、还该续跑的行。有账本时它们不是孤儿——账本记着意图，重启后接着跑，
   *  而不是让用户重点一次。没有账本就没有这一步（回落到「标 interrupted」的安全网）。 */
  recover?(): Array<{ jobId: string; kind: string; input: Record<string, unknown> }>
}

export interface StartOptions {
  options?: Record<string, unknown>
  snapshot?: ConversionSnapshot
  inputId?: string
  /** true = 无视缓存重跑（默认命中非 error 记录就直接返回它，绝不重复计费）。 */
  force?: boolean
}

export type ConversionListing = ConversionRecord & { queuePos?: number }

interface QueuedJob {
  id: string
  kind: ConversionKind
  itemId: string
  inputId?: string
  options: Record<string, unknown>
  controller: AbortController
  attempt: number
  /** 账本行号（仅接了账本时有）。 */
  jobId?: string
  /** 延迟重排的到期时刻（epoch ms）。带着它留在队列里，pump 跳过未到期者——把等待表达进队列
   *  而不是藏在定时器闭包里，等待窗内的 cancel 才能命中（一 splice 就摘掉了）。 */
  notBefore?: number
}

export class ConversionRunner {
  private readonly queue: QueuedJob[] = []
  private readonly running = new Map<string, QueuedJob>()
  private readonly byKind = new Map<ConversionKind, Converter>()
  private readonly maxConcurrent: number
  private readonly retry: { max: number; delayMs: number }
  private readonly schedule: (fn: () => void, ms: number) => void
  private readonly now: () => number
  private readonly derivations: readonly DerivationRule[]
  private readonly costarts: readonly CostartRule[]

  constructor(private readonly deps: ConversionRunnerDeps) {
    for (const c of deps.converters) this.byKind.set(c.kind, c)
    this.maxConcurrent = deps.maxConcurrent ?? 1
    this.retry = { max: deps.retry?.max ?? 2, delayMs: deps.retry?.delayMs ?? 30_000 }
    this.schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
    this.now = deps.now ?? Date.now
    this.derivations = deps.derivations
    this.costarts = deps.costarts
    // 启动续跑：账本记着意图，所以上个进程留下的行不是孤儿——重新塞回队列接着跑，而不是让
    // 用户重点一次。每条都要过一遍和 start() 同样的前置检查（记录还在吗、是不是已经 done），
    // 不过就按结果 complete/fail 掉，不入队（免得死循环空转）。
    const resumed = new Set<string>()
    for (const job of deps.ledger?.recover?.() ?? []) {
      const conversionId = job.input.conversionId as string | undefined
      const rec = conversionId ? deps.store.get(conversionId) : null
      if (!rec) {
        deps.ledger?.fail(job.jobId, '恢复时记录已不存在')
        continue
      }
      if (rec.status === 'done') {
        deps.ledger?.complete(job.jobId) // 意图已满足，不是失败
        continue
      }
      const converter = this.byKind.get(rec.kind)
      if (!converter?.available()) {
        deps.ledger?.fail(job.jobId, `${rec.kind} 后端不可用（重启恢复时）`)
        continue
      }
      deps.store.update(rec.id, { status: 'queued' })
      this.queue.push({
        id: rec.id,
        kind: rec.kind,
        itemId: rec.itemId,
        inputId: rec.inputId,
        options: job.input as Record<string, unknown>,
        controller: new AbortController(),
        attempt: 0,
        jobId: job.jobId,
      })
      resumed.add(rec.id)
    }

    // 账本救不回来的那些（没有账本、停机超过账本的孤儿阈值、或 enqueue 前就崩了）：队列活在
    // 内存里，它们永远不会自己跑完，还会把 start() 的去重卡死（"非 error 不重跑"），所以标成
    // error 把重试权交还用户。这正是原来那张安全网的最小子集。
    for (const rec of deps.store.list({ limit: 200 }).items) {
      if ((rec.status === 'running' || rec.status === 'queued') && !resumed.has(rec.id)) {
        deps.store.update(rec.id, {
          status: 'error',
          error: { code: 'interrupted', message: '转换中断（服务重启）' },
          finishedAt: new Date().toISOString(),
        })
      }
    }
    this.pump()
  }

  /** 已注册的 kind 及其可用性——能力发现端点读它。 */
  kinds(): Array<{ kind: ConversionKind; label: string; stages: string[]; available: boolean; options: Record<string, string>; branches?: Record<string, boolean> }> {
    return this.deps.converters.map((c) => ({
      kind: c.kind,
      label: c.label,
      stages: c.stages,
      available: c.available(),
      options: c.options ?? {},
      ...(c.branches ? { branches: c.branches() } : {}),
    }))
  }

  get(id: string): ConversionRecord | null {
    return this.deps.store.get(id)
  }

  // —— 转写的定向读写口 ——
  // 声纹那几条路由（读簇、归名回写、播放时间轴、出现账回填）要的是「这个 item 的转写 segments」，
  // 而不是「转换资源的通用 CRUD」。给它们目的命名的口子，HTTP 层就不必拿到 ConversionStore
  // ——否则任何路由都能对任意 kind 任意字段乱写，语义边界就没了。

  /** 该 item 最新的一条**带时间轴的** extract（= 走了转写分支的那条），含未完成的：
   *  调用方常要区分「没转过」和「转到一半」。
   *
   *  为什么不能直接 `latestFor(itemId, 'extract')`：收敛之后同一条 item 可能有多条 extract
   *  （先转写、后来又 OCR 了一张图）。取「最新的一条」会被一条 OCR 结果盖掉真正的转写，
   *  而 OCR 产不出时间轴——声纹面板会当场变空。所以判据是**带不带 segments**，不是新不新。
   *
   *  未完成的那条例外：它还没有产物，分支无从得知。这里一并返回（调用方只读它的 status），
   *  代价是一次在跑的 OCR 会被报成「转写进行中」——只影响一个进度字样，不影响任何产物。
   *
   *  挑选规则本身住在 `shared/extract/transcript.ts`（前端转写档同吃一份，见那里的头注）。 */
  transcriptOf(itemId: string): ConversionRecord | null {
    const page = this.deps.store.list({ item: itemId, kind: 'extract', limit: 50, expandResult: true })
    return pickTranscript(page.items)
  }

  /** 该 item 已完成转写里的 segments；没有就是空数组——读的一方全都只关心这个。 */
  segmentsOf(itemId: string): TranscriptSegment[] {
    const rec = this.transcriptOf(itemId)
    if (!rec || rec.status !== 'done') return []
    return segmentsIn(rec) ?? []
  }

  /** 所有已完成、且带 segments 的转写（说话人存量迁移要整库扫一遍）。 */
  allTranscripts(): Array<{ itemId: string; segments: TranscriptSegment[] }> {
    const seen = new Set<string>()
    const out: Array<{ itemId: string; segments: TranscriptSegment[] }> = []
    let cursor: string | undefined
    do {
      const page = this.deps.store.list({ kind: 'extract', status: 'done', limit: 200, cursor, expandResult: true })
      for (const rec of page.items) {
        const segments = segmentsIn(rec)
        if (!segments) continue // 非转写分支（OCR / 网页 / 直取）没有时间轴，不是「同一 item 的更新版本」
        if (seen.has(rec.itemId)) continue // 同一 item 多条 → 只取最新那条（列表已按创建序倒排）
        seen.add(rec.itemId)
        if (segments.length) out.push({ itemId: rec.itemId, segments })
      }
      cursor = page.nextCursor
    } while (cursor)
    return out
  }

  /** 列表 + 每条排队中记录的实时队位（1-based）。 */
  list(query: ListConversionsQuery): { items: ConversionListing[]; nextCursor?: string } {
    const page = this.deps.store.list(query)
    return {
      ...page,
      items: page.items.map((rec) => {
        if (rec.status !== 'queued') return rec
        const idx = this.queue.findIndex((j) => j.id === rec.id)
        return idx >= 0 ? { ...rec, queuePos: idx + 1 } : rec
      }),
    }
  }

  /**
   * 开一次转换（或直接返回已缓存的那条）。`created:false` = 命中缓存，调用方据此回 200 而非 201。
   * 未注册的 kind 抛 `unknown kind`，后端没配的抛 `unavailable`——两者都在**建记录之前**抛，
   * 不留半条垃圾记录。
   */
  start(kind: ConversionKind, itemId: string, opts: StartOptions): { record: ConversionRecord; created: boolean } {
    const converter = this.byKind.get(kind)
    if (!converter) throw new Error(`unknown conversion kind: ${kind}`)
    if (!converter.available()) throw new Error(`conversion kind unavailable: ${kind}`)

    if (!opts.force) {
      const existing = this.deps.store.latestFor(itemId, kind)
      if (existing && existing.status !== 'error') return { record: existing, created: false }
    }

    const record = this.deps.store.create({ kind, itemId, inputId: opts.inputId, snapshot: opts.snapshot })
    const jobId = this.deps.ledger?.enqueue(kind, { conversionId: record.id, itemId, ...(opts.options ?? {}) })
    this.queue.push({
      id: record.id,
      kind,
      itemId,
      inputId: opts.inputId,
      options: opts.options ?? {},
      controller: new AbortController(),
      attempt: 0,
      jobId,
    })
    this.costartFrom(kind, itemId, opts, record.id)
    this.pump()
    return { record: this.deps.store.get(record.id)!, created: true }
  }

  /**
   * 并肩起跑。**只在真的新建了一条记录时才走到这里**（`start()` 里命中去重的那条路早就 return
   * 了）——否则每次点「转成文字」命中缓存都会再排一条声纹。
   *
   * 和 `deriveFrom` 一样是加分项，不能把发起者拖下水：`start()` 在 kind 没注册或后端没配时
   * 会抛，那两种情况下这条 item 只是暂时没有这一层，发起的那条照跑。所以每一条并肩规则
   * **各自一层 try**——一条的后端没配不能连累同一轮里其余的。
   *
   * 外层单独包住 `costartsFor`：规则表的 `when` 是外部注入的函数，它抛出就当没有要并肩的。
   *
   * `force` 原样传下去：用户重跑转成文字时，并肩那条也该跟着重跑（否则新转写配的是旧说话人）；
   * 不重跑时它命中 `start()` 的去重，已经有的那条原样返回，不会重复付钱。
   */
  private costartFrom(
    kind: ConversionKind,
    itemId: string,
    opts: StartOptions,
    inputId: string,
  ): void {
    let kinds: ConversionKind[]
    try {
      kinds = costartsFor(kind, opts.options ?? {}, this.costarts)
    } catch {
      return
    }
    for (const k of kinds) {
      try {
        this.start(k, itemId, { ...opts, inputId, force: opts.force })
      } catch {
        /* 这条并肩的 kind 没注册 / 后端没配 —— 不影响发起的那条，也不影响其余并肩规则 */
      }
    }
  }

  /** 取消排队中的（出队）或正在跑的（abort）；两种情况记录都被删掉——「消灭这个意图和它的产物」。 */
  cancel(id: string): boolean {
    const qi = this.queue.findIndex((j) => j.id === id)
    if (qi >= 0) {
      const [job] = this.queue.splice(qi, 1)
      this.deps.store.delete(id)
      // 用户主动取消 = 意图消灭 → complete（抹掉账本行），不留 error 行
      if (job!.jobId) this.deps.ledger?.complete(job!.jobId)
      return true
    }
    const job = this.running.get(id)
    if (job) {
      // 就地 complete：意图已消灭，账本不用等 run() 收尾才清行。run() 稍后走到 abort 分支还会
      // 再 complete 一次——账本对已删的行是 no-op，不是重复计数。
      if (job.jobId) this.deps.ledger?.complete(job.jobId)
      job.controller.abort() // run() 看到 abort 后删记录
      return true
    }
    return false
  }

  /** 删一条记录（历史、失败、或在跑的）：先取消，再无条件删。 */
  remove(id: string): boolean {
    const existed = !!this.deps.store.get(id)
    this.cancel(id)
    this.deps.store.delete(id)
    return existed
  }

  /**
   * 上游成功后自动排下一层。**它是加分项，不能把上游拖下水**——`start()` 在 kind 没注册或
   * 后端没配时会抛，那两种情况下这条 item 只是暂时没有下一层，上游那份产物照样好好的。
   *
   * 不用担心并发越界：此刻本 job 还在 `this.running` 里（`pump()` 的 finally 尚未执行），
   * 所以 `start()` 里那次 `pump()` 最多把派生的 job 排进队列，不会突破 maxConcurrent。
   *
   * **重排的规矩**：走到这里就说明上游真的重跑过（没真跑的上游命中 `start()` 的去重、根本
   * 不会落定），所以已存的下层是对着旧产物算的——带 `force` 重排。**判据按身份，不按状态**：
   * 只有当该 (item, kind) 最新那条下层的 `inputId` 就是本轮这条上游记录的 id 时才跳过——那条
   * 才真是「本轮上游已经派出的下一层」。上一轮派出的那条（哪怕还在 queued/running）不算：
   * 它的 `inputId` 指向的是**旧**上游，跑完只会把结果回灌进那条旧记录，新上游这条永远补不上
   * 下层——和本文件要修的那个 bug 是同一个洞在并发下的翻版，而且同样没有任何一处会喊。
   *
   * **两层隔离，都不能让异常穿透 `run()` 变成 unhandled rejection**（Node 默认杀进程）：
   * 外层单独包住 `derivationsFor` 本身——规则表的 `when` 谓词是外部注入的函数，不是 runner
   * 写的，它抛出就当这条记录没有要派生的东西。内层包住循环体里每一次 `start()` 调用、逐条
   * 各自一层 try——一条派生规则的后端没配（`start()` 抛 unavailable）不能连累同一轮里排在
   * 它后面的其他规则，那些规则的产物跟这条失败毫无关系，必须照跑。两层都只是「加分项没加
   * 成」，从不影响已经落定的上游那条记录。
   */
  private deriveFrom(rec: ConversionRecord): void {
    let kinds: ConversionKind[]
    try {
      // 外层护谓词——见上方 docblock。
      kinds = derivationsFor(rec, this.derivations)
    } catch {
      return
    }
    for (const kind of kinds) {
      try {
        // 逐条各自隔离——见上方 docblock。
        const existing = this.deps.store.latestFor(rec.itemId, kind)
        // 按身份判，不按状态判：只有当最新那条下层就是本轮这条上游派出来的，才算已经有了。
        // 上一轮派的（不管是 queued/running 还是已经 done/error）一律重排——它对着的是旧上游。
        if (existing?.inputId === rec.id) continue
        // **必须 force**：走到 deriveFrom 就意味着上游**真的重跑过**（没真跑的上游命中 start()
        // 的去重、根本不会落定），所以已存的那条下层是对着**旧产物**算的，必须重算。不 force
        // 就会被 (item, kind) 去重挡掉，表现是「重转写之后说话人永远补不上」——一条没人会喊
        // 的静默退化。
        this.start(kind, rec.itemId, { inputId: rec.id, force: true })
      } catch (e) {
        // unknown kind / unavailable：都在留下任何垃圾记录之前发生，吞掉即可——
        // 上游那条记录已经落定，不受影响；只是这一条派生没有跑起来。出声一句，不然
        // 「后端没配」会永远静默地表现为「说话人从来不会被自动补上」。
        console.warn(`[conversions] derive ${rec.itemId} -> ${kind} skipped:`, (e as Error).message)
      }
    }
  }

  private pump(): void {
    while (this.running.size < this.maxConcurrent) {
      const at = this.now()
      const idx = this.queue.findIndex((j) => j.notBefore === undefined || j.notBefore <= at)
      if (idx < 0) return
      const job = this.queue.splice(idx, 1)[0]!
      this.running.set(job.id, job)
      if (job.jobId) this.deps.ledger?.markRunning(job.jobId)
      this.deps.store.update(job.id, { status: 'running', startedAt: new Date().toISOString() })
      void this.run(job).finally(() => {
        this.running.delete(job.id)
        this.pump()
      })
    }
  }

  private async run(job: QueuedJob): Promise<void> {
    const converter = this.byKind.get(job.kind)!
    const stages: ConversionStage[] = []
    const startedAtMs = this.now()
    const ctx: ConversionContext = {
      id: job.id,
      itemId: job.itemId,
      kind: job.kind,
      inputId: job.inputId,
      options: job.options,
      signal: job.controller.signal,
      jobDir: job.jobId ? this.deps.ledger?.jobDirOf(job.jobId) : undefined,
      stage: async (name, fn) => {
        const t0 = this.now()
        try {
          return await fn()
        } finally {
          stages.push({ name, ms: this.now() - t0 })
        }
      },
    }

    let outcome: ConversionOutcome
    try {
      outcome = await converter.run(ctx)
    } catch (e) {
      // 抛出来的失败也要留住梯子走法（converter 抛 LadderError 即可）——否则「为什么没出结果」
      // 恰恰在最需要它的那条路上丢失。
      outcome = { ok: false, error: { code: 'internal_error', message: String((e as Error).message) }, ladder: ladderOf(e) }
    }

    // 用户主动取消 = 意图消灭：删记录，不落终态、不发事件。
    if (job.controller.signal.aborted) {
      this.deps.store.delete(job.id)
      if (job.jobId) this.deps.ledger?.complete(job.jobId)
      return
    }

    const timing = { totalMs: this.now() - startedAtMs, stages }
    const finishedAt = new Date().toISOString()

    // 梯子走法和 timing 一样是信封信息，成功/失败两条路都落——**失败那条尤其要落**：
    // 「为什么没出结果」的答案全在梯子上（谁弃权、谁报错、报的什么）。
    const ladder = outcome.ladder

    if (outcome.ok) {
      const rec = this.deps.store.update(job.id, { status: 'done', result: outcome.result, timing, ladder, finishedAt })
      if (job.jobId) this.deps.ledger?.complete(job.jobId)
      if (rec) {
        this.deps.onSettled?.(rec)
        this.deriveFrom(rec)
      }
      return
    }

    // 可重试的失败（后端还在热身）≠ 任务失败：延迟重排整条转换，记录停在 queued——意图未了结。
    // 等待窗内的 cancel 能命中，因为 job 就躺在 this.queue 里。
    if (outcome.retryable && job.attempt < this.retry.max) {
      this.deps.store.update(job.id, { status: 'queued', timing })
      const waiting: QueuedJob = { ...job, attempt: job.attempt + 1, notBefore: this.now() + this.retry.delayMs }
      this.queue.push(waiting)
      this.schedule(() => {
        waiting.notBefore = undefined
        this.pump()
      }, this.retry.delayMs)
      return
    }

    const rec = this.deps.store.update(job.id, { status: 'error', error: outcome.error, timing, ladder, finishedAt })
    // 失败留 error 行供排障（成功/取消才抹行）。
    if (job.jobId) this.deps.ledger?.fail(job.jobId, outcome.error.message)
    if (rec) this.deps.onSettled?.(rec)
  }
}
