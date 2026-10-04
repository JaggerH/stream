import type { ExtCdpEvent } from '../http/ext-relay.ts'
import type { DomRecipeObserver, NetworkRecipeObserver, RecipeObserver, RecipeOutput, StateRecipeObserver } from './recipe.ts'
import { HarvestAccumulator, urlMatches } from './harvest.ts'
import { getPath, type MappedItem } from './interpret.ts'
import type { PageDriver } from './actions.ts'

export interface ObserverRelay {
  subscribe(tabId: number, domains: string[]): Promise<number>
  unsubscribe(subscriptionId: number): Promise<void>
  onEvent(listener: (event: ExtCdpEvent) => void): () => void
  sendCommand(tabId: number, method: string, params: unknown): Promise<any>
}

interface NetworkEventParams {
  requestId?: string
  response?: { url?: string }
}

/** A sink for freshly-scraped items, called per batch as they are accumulated — the live
 *  harvest preview stream. Fires ONLY for genuinely-new (deduped) items. */
export type LiveItemsSink = (items: MappedItem[]) => void

/** 捕获到的响应正文回传口。**只为 `extract.from.network` 存在**：凭证明文不进 items（那是收件箱），
 *  所以它需要一条不经 accumulator 的旁路。不装 = 引擎不留存任何正文，这是默认。 */
export type RawBodySink = (url: string, text: string) => void

/** Offer a body to an accumulator and hand the newly-appended (deduped) items to `onItems`.
 *  `offer` pushes fresh items to the end of `items()`, so the tail past the prior size is
 *  exactly this batch's fresh set. */
function offerAndDrain(acc: HarvestAccumulator, body: unknown, onItems?: LiveItemsSink): { fresh: number } {
  const before = acc.size
  const result = acc.offer(body)
  if (onItems && result.fresh > 0) onItems(acc.items().slice(before))
  return result
}

/**
 * 一次运行里最多挂着多少条「见了响应头、还没等到 loadingFinished」的请求。
 *
 * 只有 URL 命中某个 observer、且落在它 `windowMs` 里的响应才会进这张表，所以正常情况下它就是
 * 几条 feed 请求。设上限只为堵住病态情形：一条长连接 / SSE 只有响应头、永远不 finish，一轮几分钟
 * 的采集能攒出成千上万条。满了就淘汰最早的（Map 保插入序）——最早那条也最可能是那种不会完成的。
 */
const MAX_AWAITING_BODY = 64

/** Bounded Network observer. Site matching, body reads and mapping stay in backend. */
export class NetworkObserverPipeline {
  private readonly accumulators = new Map<NetworkRecipeObserver, HarvestAccumulator>()
  private readonly pending = new Set<Promise<void>>()
  /**
   * requestId → 该响应命中的 observer，**从响应头到达一直挂到 body 可读为止**。
   *
   * 为什么不在 `Network.responseReceived` 当场就读：那个事件的语义是**响应头到了**，不是 body 到了。
   * 此时 `Network.getResponseBody` 拿到的是 `-32000 No data found for resource with given
   * identifier`——DevTools 认得这个 requestId（所以不是 "No resource with given identifier
   * found"），只是缓冲区里还没有内容。body 完整可读的信号是 `Network.loadingFinished`。
   *
   * 活体证据（2026-07-28，douyin-search 连续两轮 0 items）：搜索结果 JSON 大几百 KB，响应头先到、
   * 主体还在传，于是每一轮那唯一一条 XHR 都读回 -32000 → 整轮颗粒无收。同一条代码路径上 xhs 一直
   * 正常出数，正是因为它的 feed 响应小到和响应头几乎同时落地——这个竞态谁先到手全看 body 大小，
   * 所以它表现为「换个站就 100% 失败」，而不是间歇性抖动。
   */
  private readonly awaitingBody = new Map<string, { observer: NetworkRecipeObserver; url: string }>()
  private readonly notes: string[] = []
  private subscriptionId: number | null = null
  private offEvent: (() => void) | null = null
  private startedAt = 0
  private stopped = false
  private readonly maxInFlight: number

  private readonly onItems?: LiveItemsSink
  private readonly onRawBody?: RawBodySink

  /** 参与 URL 匹配的全部条目 = 声明的 observers + 只捕获不累积的那些（见 `captureOnly`）。 */
  private readonly observers: NetworkRecipeObserver[]

  constructor(
    private readonly relay: ObserverRelay,
    private readonly tabId: number,
    observers: NetworkRecipeObserver[],
    private readonly output: RecipeOutput,
    opts: {
      maxInFlight?: number
      onItems?: LiveItemsSink
      onRawBody?: RawBodySink
      /**
       * 只把正文回传给 `onRawBody`、**不建 accumulator** 的条目（凭证捕获就是这一类）。
       *
       * 为什么必须单列一档：一个"只为喂 extract 而存在"的 observer 如果照常进 items 管线，它抓到的
       * 那份响应会被拿空的 output 映射去套，套不上就判成 malformed → **drift**，而 drift 优先级高于
       * `allowEmpty`，于是它盖住了 extract 的真实结论（活体：zhipu-create-key 报
       * `1 out of 1 responses were malformed`，extract 到底有没有拿到 key 完全看不见）。
       * 凭证不是 item，就不该走 item 的那条路。
       */
      captureOnly?: NetworkRecipeObserver[]
    } = {},
  ) {
    for (const observer of observers) this.accumulators.set(observer, new HarvestAccumulator(observer.input ?? output))
    // 匹配时两者平等；累积时只有前者有 accumulator，后者在 readBody 里天然跳过。
    this.observers = [...observers, ...(opts.captureOnly ?? [])]
    this.maxInFlight = opts.maxInFlight ?? 8
    this.onItems = opts.onItems
    this.onRawBody = opts.onRawBody
  }

  async start(): Promise<void> {
    if (this.subscriptionId != null) return
    this.stopped = false
    this.startedAt = Date.now()
    this.subscriptionId = await this.relay.subscribe(this.tabId, ['Network'])
    this.offEvent = this.relay.onEvent((event) => this.handleEvent(event))
  }

  private handleEvent(event: ExtCdpEvent): void {
    if (this.stopped || event.tabId !== this.tabId || event.subscriptionId !== this.subscriptionId) return
    const params = event.params as NetworkEventParams
    const requestId = params.requestId
    if (!requestId) return
    // 匹配在响应头这一刻做（URL 和 windowMs 都只有这时才成立），读 body 推迟到 loadingFinished。
    if (event.method === 'Network.responseReceived') {
      const url = params.response?.url
      if (!url) return
      const elapsed = Date.now() - this.startedAt
      const observer = this.observers.find((o) => elapsed <= o.windowMs && urlMatches(o.urlPattern, url))
      if (!observer) return
      if (this.awaitingBody.size >= MAX_AWAITING_BODY) {
        const oldest = this.awaitingBody.keys().next()
        if (!oldest.done) this.awaitingBody.delete(oldest.value)
      }
      this.awaitingBody.set(requestId, { observer, url })
      return
    }
    if (event.method === 'Network.loadingFinished') {
      const waiting = this.awaitingBody.get(requestId)
      if (!waiting) return
      // 背压时**不删**这条登记：读不下就留着，`flush()` 收尾时还会兜一次。旧实现在这里直接丢弃，
      // 一次拥塞就等于永久少一批 item。
      if (this.pending.size >= this.maxInFlight) {
        if (!this.notes.includes('network observer backpressure limit reached')) {
          this.notes.push('network observer backpressure limit reached')
        }
        return
      }
      this.awaitingBody.delete(requestId)
      this.startRead(requestId, waiting.observer, waiting.url, false)
      return
    }
    // 请求夭折（取消 / 断网 / 页面跳走）——body 永远不会有了，别把它留到 flush 再白读一次。
    if (event.method === 'Network.loadingFailed') this.awaitingBody.delete(requestId)
  }

  private startRead(requestId: string, observer: NetworkRecipeObserver, url: string, lastResort: boolean): void {
    const work = this.readBody(requestId, observer, url, lastResort).finally(() => this.pending.delete(work))
    this.pending.add(work)
  }

  private async readBody(requestId: string, observer: NetworkRecipeObserver, url: string, lastResort: boolean): Promise<void> {
    try {
      const result = await this.relay.sendCommand(this.tabId, 'Network.getResponseBody', { requestId }) as {
        body?: string
        base64Encoded?: boolean
      }
      if (typeof result.body !== 'string') return
      const bytes = result.base64Encoded
        ? Buffer.from(result.body, 'base64')
        : Buffer.from(result.body, 'utf8')
      if (bytes.byteLength > observer.maxBodyBytes) {
        this.notes.push(`network body exceeded ${observer.maxBodyBytes} bytes`)
        return
      }
      const text = bytes.toString('utf8')
      // 正文回传只在**调用方明确要**时才发生（recipe 声明了 extract.from.network）——默认不装，
      // 引擎默认路径下不留存任何响应正文。
      this.onRawBody?.(url, text)
      const acc = this.accumulators.get(observer)
      if (acc) offerAndDrain(acc, JSON.parse(text), this.onItems)
    } catch (error) {
      // 一条读不回来只损失这一条：`readBody` 从不外抛，其余响应照常累积到各自的 accumulator。
      // （douyin 每轮只发一条命中的 XHR，所以"损失一条"恰好等于"整轮 0 item"——那是条数少，
      //   不是错误传播；别把这两件事混起来当同一个 bug 修。）
      const message = error instanceof Error ? error.message : String(error)
      const what = lastResort ? 'network body unread (response never finished loading)' : 'network body read failed'
      this.notes.push(`${what}: ${message}`.slice(0, 240))
    }
  }

  /**
   * 结束观察：先等在飞的读，再给「响应头见过、却始终没等到 `loadingFinished`」的请求补最后一次读。
   *
   * 补这一次是因为 `loadingFinished` 并非必然到达（长连接 / SSE、页面在传输中途跳走、订阅建立时
   * 请求已在半途）。这时读回 -32000 是大概率——但那正是它只配当兜底、不配当主路径的原因，
   * 而不是不读的理由：读一次最多多一行诊断，不读就一定丢一批 item。
   *
   * **只能在这里补，不能挪到 `stop()`**：runner 是 `flush()` → `observe('final')` → `items()`
   * → …… → `stop()`（`recipe-runner.ts:618/622/656`），到 `stop()` 时结果早已取走，那时读回来的
   * body 谁也看不见。同理，`flush()` 在一轮运行里只被调用这一次，所以"补读"不会误伤仍在传输、
   * 本可以正常等到 `loadingFinished` 的请求。
   */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending])
    if (this.stopped) return // stop() 也会 flush 一次，那时结果已取走，别再白打一趟 relay
    while (this.awaitingBody.size > 0) {
      for (const [requestId, waiting] of [...this.awaitingBody].slice(0, this.maxInFlight)) {
        this.awaitingBody.delete(requestId)
        this.startRead(requestId, waiting.observer, waiting.url, true)
      }
      while (this.pending.size > 0) await Promise.all([...this.pending])
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.offEvent?.()
    this.offEvent = null
    await this.flush()
    const id = this.subscriptionId
    this.subscriptionId = null
    if (id != null) await this.relay.unsubscribe(id).catch(() => {})
  }

  items(): MappedItem[] {
    return mergeByIdentity(this.output, [...this.accumulators.values()].flatMap((accumulator) => accumulator.items()))
  }

  driftReason(): string | null {
    for (const accumulator of this.accumulators.values()) {
      const reason = accumulator.driftReason()
      if (reason) return reason
    }
    return null
  }

  diagnostics(): string[] {
    return [...this.notes]
  }
}

/**
 * 单次 `readState` 的上限。**不是** recipe 的总预算 —— 那是 observer 自己的 `maxWaitMs`。
 *
 * 为什么必须有：`maxWaitMs` 只在**两次读之间**被检查，所以它只在"每次读都会返回"的前提下
 * 成立。渲染进程半死之后（活体 2026-07-27，`page.goto: Page crashed` 之后的下一次运行）
 * 一次 `page.evaluate` 就永不 resolve —— Playwright 的 `page.evaluate` **不吃 timeout 参数** ——
 * poll 循环走不到下一轮，`maxWaitMs` 形同虚设，运行几分钟不结束、还占着该 facility 的 lane。
 * 挂死比 502 更坏：502 至少会把 lane 还回来。
 *
 * 值怎么来的（三条一起夹）：
 * - **不超过 `maxWaitMs / 3`** —— 从 observer 自己声明的总预算推导，而不是另拍一个魔数。
 *   取三分之一而不是全额：单次读若能吃掉整个 `maxWaitMs`，一次挂死照样把整轮等待赔光，
 *   poll 循环就白设了；留三分之一意味着同一预算内还有至少两次重试。
 * - **不超过 5s 的天花板** —— 健康的一次读就是一趟 in-page evaluate 往返（几十 ms 量级；
 *   唯一的活体 state observer `xhs-detail` 的 `pollMs` 就是 50，循环本身即假定读远快于此）。
 *   5s 高出健康值两个数量级，只可能在"页面根本不答话"时触发；也和本仓库既有的
 *   `CLICK_WAIT_MS = 5000`（browser-drive.ts）同一量级。`xhs-detail` 的 `maxWaitMs` 是 15000，
 *   三分之一恰好也是 5000 —— 对唯一的活体用例，两条规则给出同一个答案。
 * - **不低于 1s 的地板** —— 没声明 `maxWaitMs` 的 observer 只读一次，"零的三分之一"不成其为预算；
 *   1s 仍然远高于健康读，不会把一个装了大 store 的冷页面误判成挂死。
 *
 * 两条 transport 都被这一层盖住（timeout 加在**调用点**，与驱动无关）：cloak 那条本来完全无界；
 * ext 那条经 `ExtRelay` 每条命令有 30s 上限，本来就有界，这里只是把它收得更紧 —— 没有重复加。
 */
export const STATE_READ_TIMEOUT_CAP_MS = 5000
export const STATE_READ_TIMEOUT_FLOOR_MS = 1000

export function stateReadTimeoutMs(maxWaitMs: number | undefined): number {
  const third = Math.floor((maxWaitMs ?? 0) / 3)
  return Math.min(STATE_READ_TIMEOUT_CAP_MS, Math.max(STATE_READ_TIMEOUT_FLOOR_MS, third))
}

/** 单次读超时的哨兵 —— 和"页面确实返回了 undefined"必须分得开，两者的诊断结论不同。 */
const READ_TIMED_OUT = Symbol('state-read-timed-out')

/**
 * state 观察这一段用到的**全部**时间来源：总预算的计时（`now`）和单次读的超时铃（`bell`）。
 *
 * 为什么要能注入：这两处必须走**同一把尺子**。它们各读各的钟时，"读超时了还剩多少总预算"
 * 就取决于机器当下有多忙 —— 全量并行压满时 `setTimeout(1000)` 可能 3s 后才响，于是第一次
 * 读的铃一响，`maxWaitMs: 3000` 也同时烧光，poll 循环少跑一轮。用例里表现为偶发红
 * （`observer-pipeline.test.ts` 那条「keeps polling after a read times out」），线上表现是
 * 重试次数被负载偷走 —— 同一个成因。
 */
export interface ReadClock {
  now(): number
  /** ms 之后响；`cancel` 让先返回的读能立刻拆掉计时器，不留悬挂的 timer。 */
  bell(ms: number): { rang: Promise<void>; cancel(): void }
}

const REAL_CLOCK: ReadClock = {
  now: () => Date.now(),
  bell(ms) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const rang = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
    return { rang, cancel: () => { if (timer) clearTimeout(timer) } }
  },
}

/**
 * 给一次读加上限。超时只结束**这一次读**，不结束整轮等待 —— 语义上"这轮没读到"和
 * "读到了空"是同一类，后面的 `maxWaitMs` 检查照旧兜住总时长。
 *
 * `Promise.race` 会给输入的 promise 挂上处理器，所以那个永不 resolve 的读即使日后 reject
 * 也不会变成 unhandledRejection；它只是被丢下（in-page 的 evaluate 无从中止）。
 */
async function readWithin<T>(read: () => Promise<T>, ms: number, clock: ReadClock): Promise<T | typeof READ_TIMED_OUT> {
  const { rang, cancel } = clock.bell(ms)
  try {
    return await Promise.race([read(), rang.then((): typeof READ_TIMED_OUT => READ_TIMED_OUT)])
  } finally {
    cancel()
  }
}

/** Is the normalized state read populated — and, when declared, complete? */
function ready(items: unknown, readyWhen: string | undefined): boolean {
  const rows = Array.isArray(items) ? items : items == null ? [] : [items]
  if (rows.length === 0) return false
  return readyWhen == null || rows.some((row) => getPath(row, readyWhen))
}

/** Merge item batches by the recipe's output identity; later batches win on conflicts. */
function mergeByIdentity(output: RecipeOutput, items: MappedItem[]): MappedItem[] {
  const merged = new Map<string, MappedItem>()
  for (const item of items) {
    const key = item[output.dedupeBy] ?? item.guid
    if (key != null) merged.set(String(key), item)
  }
  return [...merged.values()]
}

/** Composes bounded network observation with declared DOM/state snapshots. */
export class ObserverPipeline {
  private readonly local = new Map<DomRecipeObserver | StateRecipeObserver, HarvestAccumulator>()
  private readonly network: NetworkObserverPipeline | null
  private readonly params: Record<string, string>
  /** items produced by a step (in-page evaluate), not by an observer */
  private readonly stepFed: HarvestAccumulator
  private readonly notes: string[] = []
  private readonly onItems?: LiveItemsSink
  private readonly clock: ReadClock
  private readonly signal?: AbortSignal

  constructor(
    private readonly driver: PageDriver,
    private readonly observers: RecipeObserver[],
    private readonly output: RecipeOutput,
    opts: {
      relay?: ObserverRelay
      tabId?: number
      params?: Record<string, string>
      onItems?: LiveItemsSink
      onRawBody?: RawBodySink
      /** `extract.from.network` 的 glob —— 引擎**自己**挂一份只捕获不累积的网络观察，
       *  recipe 不必（也不该）为了取凭证去声明一个 observer。 */
      secretCapture?: string
      /** state 观察的时钟（见 `ReadClock`）。生产不传 = 真实时钟；用例传假钟以摆脱墙钟。 */
      clock?: ReadClock
      /**
       * 「还有人要这次结果吗」。**必须钉在这个 poll 循环上**：state 观察是一次运行里最长的一段
       * 等待（xhs-detail 声明 15s），少了它，取消只能等到下一个 step 边界——而那次等待本身就是
       * 用户在等的那十几秒。
       */
      signal?: AbortSignal
    } = {},
  ) {
    this.onItems = opts.onItems
    this.clock = opts.clock ?? REAL_CLOCK
    this.signal = opts.signal
    const networks = observers.filter((o): o is NetworkRecipeObserver => o.kind === 'network')
    // 凭证捕获的窗口跟着整轮运行走（建 key 要开弹窗、填名字、等一个往返），body 给 64KB
    // ——一份凭证响应远小于这个数，上限只是防一个意外命中的大响应把内存吃掉。
    const captureOnly: NetworkRecipeObserver[] = opts.secretCapture
      ? [{ kind: 'network', urlPattern: opts.secretCapture, windowMs: 300_000, maxBodyBytes: 65_536 }]
      : []
    this.network = opts.relay && opts.tabId != null && (networks.length || captureOnly.length)
      ? new NetworkObserverPipeline(opts.relay, opts.tabId, networks, output, {
          onItems: opts.onItems, onRawBody: opts.onRawBody, captureOnly,
        })
      : null
    this.params = opts.params ?? {}
    this.stepFed = new HarvestAccumulator(output)
    for (const observer of observers) if (observer.kind !== 'network') this.local.set(observer, new HarvestAccumulator(observer.input ?? output))
  }

  async start(): Promise<void> { await this.network?.start() }

  /** Feed a step-produced body (one in-page evaluate page) through the recipe output. */
  offer(body: unknown): { fresh: number } {
    return offerAndDrain(this.stepFed, body, this.onItems)
  }

  async observe(trigger: 'entry' | 'after-step' | 'final'): Promise<void> {
    for (const [observer, accumulator] of this.local) {
      if (observer.trigger !== trigger) continue
      if (observer.kind === 'dom') {
        if (!this.driver.readItems) throw new Error('recipe requires DOM read capability')
        offerAndDrain(accumulator, { items: await this.driver.readItems(observer.itemSelector, observer.fields) }, this.onItems)
      } else {
        if (!this.driver.readState) throw new Error('recipe requires state read capability')
        const identity = observer.identityParam ? this.params[observer.identityParam] : undefined
        const deadline = this.clock.now() + (observer.maxWaitMs ?? 0)
        // 单次读的上限（见 stateReadTimeoutMs 头注）：没有它，`deadline` 只在两次读之间被检查，
        // 一次挂住的读就把这个总上限架空了。
        const readTimeout = stateReadTimeoutMs(observer.maxWaitMs)
        let timedOutReads = 0
        let last: unknown
        do {
          // 取消检查在**发起下一次读之前**：已经在飞的那次读停不下来（in-page evaluate 无从中止），
          // 但不该再发新的，更不该把剩下的预算等完。抛出去由 runner 判成 `cancelled`。
          if (this.signal?.aborted) throw new Error('recipe cancelled')
          const read = await readWithin(() => this.driver.readState!(observer.statePath), readTimeout, this.clock)
          // 超时这一轮当作"没读到"继续 poll；`last` 不被它污染 —— 否则下面的诊断会把
          // "页面不答话"报成"这个 state 压根不存在"，两者的排查方向完全不同。
          if (read === READ_TIMED_OUT) timedOutReads++
          const value = read === READ_TIMED_OUT ? undefined : read
          if (read !== READ_TIMED_OUT) last = value
          const items = observer.collection === 'values' && value && typeof value === 'object'
            ? Object.entries(value as Record<string, unknown>)
                .filter(([key]) => identity == null || key === identity)
                .map(([key, item]) =>
                  observer.keyField && item && typeof item === 'object'
                    ? { ...item as Record<string, unknown>, [observer.keyField]: key }
                    : item,
                )
            : observer.collection === 'single' ? [value] : value
          // 这一轮的总预算用尽（`maxWaitMs`）—— 和上面单次读的超时是两回事，别混
          const waitExhausted = this.clock.now() >= deadline
          if (ready(items, observer.readyWhen) || waitExhausted) {
            // offer only once the item is COMPLETE (or the wait ran out) — the accumulator
            // dedupes, so an early partial offer would be the version we keep forever
            offerAndDrain(accumulator, { items }, this.onItems)
            if (accumulator.size > 0 || waitExhausted) break
          }
          await this.driver.sleep(observer.pollMs ?? 250)
        } while (true)
        // An empty state read has four very different causes — the page stopped answering at all,
        // the page never got there, the shape moved, or this run's identity is simply not in the
        // map. Say which.
        if (accumulator.size === 0) {
          if (timedOutReads > 0) {
            this.notes.push(
              `state ${observer.statePath} read timed out ${timedOutReads}x (>${readTimeout}ms each) — the page stopped answering`,
            )
          } else if (last == null) this.notes.push(`state ${observer.statePath} absent on the page`)
          else if (identity != null && typeof last === 'object') {
            const keys = Object.keys(last as Record<string, unknown>)
            this.notes.push(`state ${observer.statePath} has no entry for ${identity} (keys: ${keys.slice(0, 5).join(', ') || 'none'})`)
          } else this.notes.push(`state ${observer.statePath} produced no items`)
        }
      }
    }
  }

  async flush(): Promise<void> { await this.network?.flush() }
  async stop(): Promise<void> { await this.network?.stop() }

  items(): MappedItem[] {
    // The merge order IS the harvest order (mergeByIdentity keeps an identity at its first-seen
    // position and its last-seen value):
    //  - dom fallbacks first, so any primary observer overwrites their entry for the same identity —
    //    a fallback never downgrades a richer primary item, it only fills what nothing else produced;
    //  - then entry-trigger observers: they read what the page ALREADY HELD before any request went
    //    out (an SSR first batch), so those items genuinely precede everything the network can see.
    //    Put them after the network and the harvest comes back with the feed's second batch first —
    //    which silently misorders the ledger that locate and the UI both depend on;
    //  - then the network, the remaining local observers, and anything a step produced.
    const isFallback = (o: DomRecipeObserver | StateRecipeObserver) => o.kind === 'dom' && o.fallback === true
    const pick = (want: (o: DomRecipeObserver | StateRecipeObserver) => boolean) =>
      [...this.local].filter(([o]) => want(o)).flatMap(([, a]) => a.items())
    return mergeByIdentity(this.output, [
      ...pick(isFallback),
      ...pick((o) => !isFallback(o) && o.trigger === 'entry'),
      ...(this.network?.items() ?? []),
      ...pick((o) => !isFallback(o) && o.trigger !== 'entry'),
      ...this.stepFed.items(),
    ])
  }

  driftReason(): string | null {
    for (const accumulator of [...this.local.values(), this.stepFed]) {
      const reason = accumulator.driftReason()
      if (reason) return reason
    }
    return this.network?.driftReason() ?? null
  }

  /** Why a run came back empty — the observers' own account, for the failure reason. */
  diagnostics(): string[] {
    return [...this.notes, ...(this.network?.diagnostics() ?? [])]
  }
}
