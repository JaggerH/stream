import crypto from 'node:crypto'
import { detectLoginState, makeRandom, runActions, locateCard, observeOpened, waitForSelector, waitForSettle, StepExpectError, StepResultError, FeatureDriftError, WalledError, ChallengedError, type ActionTrace, type PageDriver } from './actions.ts'
import { ObserverPipeline, type ObserverRelay } from './observer-pipeline.ts'
import { urlMatches } from './harvest.ts'
import type { CanonicalBrowserRecipe, RecipeAction, RecipeStep, StepExpect, StepSettle } from './recipe.ts'
import type { MappedItem } from './interpret.ts'
import { getPath, substitute } from './interpret.ts'
import { RunProbe, type PhaseTiming } from './recipe-probe.ts'
import { assembleGraph } from './state-assemble.ts'
import { classifyByState, type StateVerdict } from './state-classify.ts'
import { BUILTIN_STATES } from './states-builtin.ts'
import type { Observation, StateGraph } from './state-graph.ts'
import { DEFAULT_BUDGET } from './state-machine.ts'
import { captureBrowserScene, type Scene } from './scene.ts'
import type { RepairRunner } from './repair-runner.ts'

/**
 * 撞上一个已声明为死路的全局状态（CF 封禁页那种）——这一趟没有出路，直接终止。
 * 外层把它翻成 `challenged`：**recipe 一个字都没坏**，判 drift 会去修一份没坏的东西。
 */
class StateDeadEndError extends Error {
  constructor(state: string, why: string) {
    super(`${state}：${why}`)
    this.name = 'StateDeadEndError'
  }
}

/**
 * 一趟跑完、一条 item 都没有——**这是最常见的那种失败，不是特例**。
 *
 * 它必须以异常的形式离开 try：**失败之后的那整套认领现场（状态图 classify / AI 介入交接 /
 * 补一次撞墙探测 / 抓失败现场）只住在 catch 里，只有一份**。从 try 里直接 `return
 * { outcome:'blocked'|'drift' }` 等于开了第二个出口，而那个出口把上面四样全部静默跳过——
 * 活体（2026-09-11）：一份故意改坏的 xhs-search 跑 41s 报 `blocked: recipe produced no items`，
 * `repairRunner` 明明接好了，却一次介入都没有发起。两个出口，总有一个悄悄少做事。
 */
class EmptyHarvestError extends Error {
  constructor(readonly outcome: 'drift' | 'blocked', message: string) {
    super(message)
    this.name = 'EmptyHarvestError'
  }
}

/** 逃生动作的**全部**词汇：等，和一次可信点击。**不扩充**——再往前就不是定位问题了。 */
type EscapeStep =
  | { kind: 'wait'; ms: number }
  /** `position` 是**框内偏移**（同 `PageDriver.click` 的契约），不给就是中心。
   *  Turnstile 那一格必须给：widget 是 300×72，中心落在「请验证您是真人」那行字上，
   *  实测点中心 12 秒无反应、改点左侧方块一秒通过。 */
  | { kind: 'click'; selector: string; position?: { x: number; y: number } }

/** 状态图是数据，逃生动作得在运行时验形状；认不出的原样丢掉（见调用处：一条都不剩就不逃）。 */
function isEscapeStep(s: unknown): s is EscapeStep {
  const v = s as { kind?: unknown; ms?: unknown; selector?: unknown }
  if (v?.kind === 'wait') return typeof v.ms === 'number'
  if (v?.kind === 'click') return typeof v.selector === 'string'
  return false
}

/** 逃生口的 `position`：形状不对就当没给（回落到点中心），不抛——逃生口是兜底路径，
 *  为一个写歪的坐标把整趟运行变成另一种失败不划算。 */
function escapePosition(s: EscapeStep): { x: number; y: number } | undefined {
  if (s.kind !== 'click') return undefined
  const p = s.position
  return typeof p?.x === 'number' && typeof p?.y === 'number' ? p : undefined
}

async function runEscapeStep(driver: PageDriver, s: EscapeStep): Promise<void> {
  if (s.kind === 'wait') return driver.sleep(s.ms)
  // 点不中不算错：障碍可能在这两步之间自己过去了。真相由紧接着重跑的那一步给出。
  await driver.click(s.selector, escapePosition(s))
}

/** An in-page call that threw (risk-control body, site module moved) — the recipe needs repair. */
class EvaluateDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluateDriftError'
  }
}

export interface RecipeRunOutcome {
  /** `unavailable` = 环境没就绪（浏览器没连），**recipe 一步都没跑**——不是关于源的判断。
   *  和 `blocked`（站点拦了我们）严格分开：把前者当后者，用户关一晚电脑就会让所有源变红。 */
  /** `challenged` = 站方的风控挑战（验证码遮罩之类）。和 `needsLogin` 严格分开：**登录态好好的**，
   *  用户什么都不用做，等 facility 冷却即可；判成 needsLogin 会把人支去白登录一次，判成 `drift`
   *  更糟——三次就被 `RepairLedger` 静默隔离（见 `SiteChallengeError`）。 */
  outcome: 'ok' | 'needsLogin' | 'challenged' | 'blocked' | 'drift' | 'cancelled' | 'unavailable'
  items: MappedItem[]
  trace: ActionTrace[]
  reason?: string
  /** per-phase wall-clock for this single run (see RunProbe) */
  timing?: PhaseTiming[]
  /** one-shot-capture status line — WHAT happened, never the captured value (see RecipeExtract) */
  extract?: string
  /** 失败时的现场（见 FailureScene）。成功的运行不带。 */
  scene?: FailureScene
}

export interface RecipeRunnerOptions {
  relay?: ObserverRelay
  tabId?: number
  signal?: AbortSignal
  /**
   * The driver rides a tab the USER has open (see `CanonicalBrowserRecipe.adoptTab`): its render
   * is live, so the runner must not navigate or reload it at entry — that would throw away what
   * the user is looking at, and there is nothing stale to refresh in the first place.
   */
  adoptedTab?: boolean
  /**
   * Where a `recipe.extract` capture goes. The caller binds it to THIS recipe's own
   * `runtime_config.ref` and its declared secret fields, which is exactly why the recipe body
   * carries no ref: with the target fixed outside the recipe, a recipe cannot name someone
   * else's configuration at run time. Absent = the capture is refused, not silently dropped.
   */
  onExtract?: (field: string, value: string) => void
  /**
   * 这一次运行额外用哪张状态图——**本地那份，不是整张**。内置的全局那张
   * （`BUILTIN_STATES`）由 runner 自己并进去，省略这个参数就只剩全局那张。
   *
   * **装配放在 runner 里而不是交给调用方**：让调用方自己 `assembleGraph` 意味着漏做一次就
   * 把 CF 三档整体换掉，而症状是"这个源莫名其妙被隔离"——没有任何一处会说出原因。
   * 唯一做得对的写法就该是唯一能写的写法。
   *
   * **注入在这里而不是在 runner 的构造上**：图是「这一次运行用哪张」，不是「这个 runner 永远
   * 用哪张」——将来 per-recipe 的 `.states.json` 落地时按次传入，正是这个参数存在的意义。
   */
  stateGraph?: StateGraph
  /**
   * 介入闸的收件人（spec §4）。**只在 `identify()` 落空时被叫**：`unknown` → proposeState、
   * `ambiguous` → proposeDiscriminator。省略 = 不介入，行为与从前逐字节一致。
   * 它是异步收件人：提议交出去之后这一趟**照旧**走 retryFrom / 失败——不在同一趟里重走。
   */
  repairRunner?: RepairRunner
  /**
   * 一趟最多问几次（spec §8 的账）。默认 `DEFAULT_BUDGET.repairs`。
   *
   * **闸必须装在这里**，不在收件人那边：一趟里每问一次都要先抓一次现场（整页截图 + 元素清单），
   * 那笔开销在收件人拿到提议之前就已经花掉了。所以超预算的判据是「连现场都不抓」。
   */
  repairBudget?: number
  /**
   * 每次 `identify()` 认出状态时记一笔观测（喂区分度闸，spec §9.1）。省略 = 不记。
   *
   * **和 `repairRunner` 是两件事，别合并**：介入只在识别**落空**时发生，而账本要的恰恰是
   * 识别**成功**的那些——只记失败的话，闸永远没有历史可撞，等于装了一道永远开着的门。
   */
  onObserved?: (o: Observation) => void
  /**
   * `locate` 步的坐标系：这个 facility 的标签上此刻铺着哪些条目、按什么顺序（`FeedLedger.ordered`）。
   * 调用方没传 `params[step.orderedParam]` 时，runner 按 recipe 的 facility 问它；传了（哪怕是空
   * 数组）就尊重调用方。
   *
   * **为什么在 runner 而不在调用方**：「在 feed 上找卡片」当然要 feed 的顺序——那是 locate 步的
   * 运行契约，不属于任何一个调用方。让每个调用方自己塞 `ordered`，就是让包代码、HTTP 面、MCP
   * 面各写一份"去账本取一下"，漏的那一份不报错、只是每次都 MISS 落 fallback-nav。
   * 账本本身住在 harvest 域，经 `SessionRecipeExecutor` 递进来；省略 = 没有账本可问。
   */
  orderedFor?: (facility: string) => string[]
}

/** origin+pathname equality — query/hash differences still count as "on the entry page" */
function onEntryPage(here: string, entryUrl: string): boolean {
  try {
    const a = new URL(here)
    const b = new URL(entryUrl)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

/** 一次失败运行的现场：页面当时是什么样，而不只是"什么没发生"。 */
export interface FailureScene {
  url?: string
  /** 整页可见文本的开头 —— 站点自己的报错("验证失败""名称已存在")几乎总在这里 */
  text?: string
  /** 视口截图（base64 JPEG）。DOM 描述不了的东西（closed shadow root 里的挑战 widget）只有它看得见 */
  shot?: string
  title?: string
}

/**
 * 抓一次现场，**每一项都独立 best-effort**：tab 可能正在关、页面可能已经跳走。
 * 取证失败绝不能盖掉真正的失败原因 —— 那会把"recipe 为什么没成"换成"取证为什么崩了"。
 */
async function captureScene(driver: PageDriver, fallbackUrl: string): Promise<FailureScene> {
  const scene: FailureScene = {}
  scene.url = (await driver.currentUrl?.().catch(() => undefined)) ?? fallbackUrl
  const probe = await driver
    .evalJson?.('(()=>({t:document.title,x:(document.body&&document.body.innerText||"").slice(0,1200)}))()')
    .catch(() => undefined)
  const p = probe as { t?: string; x?: string } | undefined
  if (p?.t) scene.title = p.t
  if (p?.x) scene.text = p.x
  // 整屏优先（同 `captureBrowserScene`）：滚过几十屏之后按 body 矩形裁必然失败；后台档标签
  // 两条路都拿不到帧，回 undefined 是事实不是缺陷（见 `PageDriver.shotViewport` 头注）。
  scene.shot = driver.shotViewport
    ? ((await driver.shotViewport().catch(() => null)) ?? undefined)
    : ((await driver.shotOf?.('body').catch(() => null)) ?? undefined)
  return scene
}

/**
 * 把一次 `unknown` / `ambiguous` 判决交给介入闸——带现场、带已知词汇。
 *
 * 三条边界：
 * - **只在认不出的时候交。** `identified` / `escapable` / `deadEnd` 都已经有结论了，
 *   交上去只会让收件人去回答一个没人问的问题。
 * - **抓现场失败不许盖掉判决。** 取证是旁路，判决早就下完了——让一次取证把一趟失败
 *   换成另一种失败，正是排查时最贵的那种噪音（同 `captureScene` 的头注）。
 * - **收件人抛错也不许掀翻采集。** 它是接缝，不是主路：喊一声，继续。
 *
 * 交出去**不代表这一趟会重走**：提议是给下一趟（和给人）的，见 `StateProposal` 的头注。
 */
async function handOffVerdict(
  repair: RepairRunner | undefined,
  verdict: StateVerdict,
  driver: PageDriver,
  graph: StateGraph,
  sourceId: string,
  facility: string,
  fallbackUrl: string,
  where: string,
  /** 介入预算闸：还能问 → true 并计一次；用完 → false。见 `RecipeRunnerOptions.repairBudget`。 */
  takeAsk: () => boolean,
): Promise<void> {
  if (!repair) return
  if (verdict.kind !== 'unknown' && verdict.kind !== 'ambiguous') return
  // 预算判在抓现场**之前**：现场（整页截图 + 元素清单）是这条闸专属的开销，一趟决定不再问了
  // 就一分钱都不该花——把闸装在收件人那边只会让开销照旧发生。
  if (!takeAsk()) return
  let scene: Scene | undefined
  try {
    scene = await captureBrowserScene(driver, fallbackUrl)
  } catch {
    scene = undefined
  }
  const base = { sourceId, facility, observed: [] as string[], ...(scene ? { scene } : {}), known: graph.states }
  try {
    if (verdict.kind === 'ambiguous') {
      await repair.proposeDiscriminator({
        ...base,
        kind: 'discriminator',
        candidates: verdict.candidates,
        reason: `${where}：同时命中 ${verdict.candidates.join('、')}`,
      })
    } else {
      await repair.proposeState({ ...base, kind: 'state', reason: `${where}：状态图一个都没认出` })
    }
  } catch (e) {
    // 收件人自己的问题不该掀翻采集：喊一声，继续。
    console.error(`[state] 介入闸收件人抛错，本次忽略：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * `openTarget` / `locate` 这两类步骤的 `expect` 闸门。
 *
 * 它们不是裸奔的：两者都有**内建确认**（`observeOpened` 判 URL 带不带 identity，不成就回落
 * `fallbackUrl`）。内建确认回答的是「**打开了没**」；`expect` 是使用者自己写的额外判据，回答
 * 「**打开的是不是我要的那个 / 页面到位了没**」。所以它跑在内建确认**之后**——先确认开了，
 * 再确认开对了。
 *
 * 而且必须跑在 `observers.observe('after-step')` **之前**：observer 一旦从一个错的页面上把数据
 * 读走，拿到的是真数据、只是来自别处——这是最难查的一类错，没有任何症状指向这里。
 *
 * `fallback-nav` 那条路同样要过这道闸门：页面照样是"打开了"，只是走的另一条路，而 `expect`
 * 判的是**最终状态**，不是走哪条路到的。
 *
 * 不满足就抛 `StepExpectError` —— 和 `runActions` 那条路径**同一个**错误类型、同一句话。不降级成
 * warning：因果链断在这里，后面的步骤只会以无关症状失败。
 *
 * 这里不认 `expect.retryEvery`（"每隔这么久把动作重做一遍"）：locate 重做 = 重新滚动定位 + 一次
 * 拟人点击，openTarget 自带 `maxScrolls` 重试循环，两者各自已经有兜底。装载期就在 recipe-store
 * 里拒掉，所以运行时不需要在这儿静默忽略它。
 *
 * 等待原语复用 `actions.ts` 的 `waitForSelector` —— 这个代码库里"等某特征出现"的唯一实现，
 * `cdp_act` 的 expect 和 recipe 动作步骤的 expect 走的也是它。
 */
async function gateStepExpect(driver: PageDriver, stepIndex: number, want: StepExpect | undefined): Promise<void> {
  if (!want) return
  const met = await waitForSelector(driver, want.selector, { state: want.state, timeout: want.timeout })
  if (!met) throw new StepExpectError(stepIndex, want)
}

/** 抽取等值出现的默认上限：够一次"提交→服务端建好→渲染"的往返。 */
export const EXTRACT_DEFAULT_MS = 15_000
const EXTRACT_POLL_MS = 250

/**
 * 抽取要读的"页面文本" = 可见文本 **加上表单控件的当前值**。
 *
 * `innerText` **不包含 `<input>` 的 value** —— 而"只显示一次"的凭据几乎总是放在一个只读输入框里
 * 配一个复制按钮（Groq 就是）。活体证据：整条链路全通、key 真的建出来了，抽取却报"命中 0 处"，
 * 只因为读的地方从一开始就看不见它。
 */
const EXTRACT_TEXT_EXPR =
  '(()=>{const p=[document.body?document.body.innerText:""];' +
  'for(const el of document.querySelectorAll("input,textarea")){if(el.value)p.push(el.value)}' +
  'return p.join("\\n")})()'

/**
 * One-shot capture: pull a value that exists ONLY on this screen (a freshly created API key)
 * out of the rendered page and hand it to the sink. Returns a status line for the trace —
 * WHAT happened and how long the value was, never the value.
 *
 * Every branch here is a refusal to write rather than a best effort, because the destination is
 * credential storage:
 * - no sink wired → refuse (the caller is what binds the target ref; unbound means unowned)
 * - regex matched 0 or >1 DISTINCT strings → refuse. Two different candidates means the page
 *   shows more than one key-shaped string and picking either is a guess; a guessed credential
 *   surfaces downstream as "the key doesn't work", nowhere near here. (Identical repeats — the
 *   value shown in a field AND in a copy tooltip — dedupe to one and are fine.)
 */
export async function captureSecret(
  extract: { field: string; pattern: string; timeout?: number; from?: { network: string } },
  driver: PageDriver,
  sink?: (field: string, value: string) => void,
  /** 本轮 network observer 捕获到的响应正文。只有 `extract.from.network` 声明了才会被装配
   *  —— 没声明就没人收集正文，这个参数也就该是 undefined。 */
  capturedBodies?: () => Array<{ url: string; text: string }>,
): Promise<string> {
  if (!sink) return 'extract 拒绝：没有装配 secret sink（调用方未绑定目标配置）'
  const fromNetwork = extract.from?.network
  // 声明了 network 来源却没人收集正文 = recipe 少挂了对应的 network observer。这是配置错，
  // 不是"没找到"——报成 0 处会把人送去查正则，而真因在 observers 那一段。
  if (fromNetwork && !capturedBodies) return 'extract 拒绝：声明了 from.network 但本轮没有 network observer 收集响应正文'
  if (!fromNetwork && !driver.evalJson) return 'extract 拒绝：该 driver 不支持页内求值'
  let re: RegExp
  try {
    re = new RegExp(extract.pattern, 'g')
  } catch (error) {
    return `extract 拒绝：正则不合法（${error instanceof Error ? error.message : String(error)}）`
  }
  // 轮询而不是读一次：提交之后 key 要一个网络往返才渲染。读一次的代价活体见过了——
  // 提交点下去 196ms 就去读，页面上还什么都没有，报"命中 0 处"，看起来像抽取坏了。
  const deadline = Date.now() + (extract.timeout ?? EXTRACT_DEFAULT_MS)
  // 干草堆按来源换，针的挑法不换：两条路都是"整段文本上跑同一个正则、去重后必须恰好一处"。
  const haystack = fromNetwork
    ? async () => capturedBodies!().filter((b) => urlMatches(fromNetwork, b.url)).map((b) => b.text).join('\n')
    : async () => String((await driver.evalJson!(EXTRACT_TEXT_EXPR).catch(() => '')) ?? '')
  let hits: string[] = []
  for (;;) {
    hits = [...new Set((await haystack()).match(re) ?? [])]
    if (hits.length > 0 || Date.now() >= deadline) break
    await driver.sleep(EXTRACT_POLL_MS)
  }
  if (hits.length !== 1) {
    // 同一条纪律：一句话必须能分开两个世界。只说"命中 0 处"时，"正则不对"和"正文压根没捕到"
    // 长得一模一样 —— 活体上就是这两个可能叠在一起，把人架住。所以把干草堆本身报出来。
    const where = fromNetwork
      ? (() => {
          const matched = capturedBodies!().filter((b) => urlMatches(fromNetwork, b.url))
          return `（glob "${fromNetwork}" 匹配到 ${matched.length} 份响应正文，共 ${matched.reduce((n, b) => n + b.text.length, 0)} 字符）`
        })()
      : ''
    return `extract 未写入：命中 ${hits.length} 处，要求恰好 1 处${where}`
  }
  sink(extract.field, hits[0])
  return `extract → ${extract.field}（${hits[0].length} 字符）`
}

type EvaluateStep = Extract<RecipeStep, { kind: 'evaluate' }>
type OpenTargetStep = Extract<RecipeStep, { kind: 'openTarget' }>
type LocateStep = Extract<RecipeStep, { kind: 'locate' }>

/**
 * 走 `runActions` 的普通动作步骤（scroll / click / type / goto / submit / openItems）。
 * 另外三类（`evaluate` / `openTarget` / `locate`）自带复杂逻辑，各有自己的执行器。
 */
function isActionStep(step: RecipeStep): step is RecipeAction {
  return step.kind !== 'evaluate' && step.kind !== 'openTarget' && step.kind !== 'locate'
}

/**
 * 一个 step 执行器干活需要的一切。
 *
 * **刻意做成一个可扩展的上下文对象，而不是让执行器闭包捕获 `driver`/`probe`。** 执行器分派点
 * 建起来的意义就在这儿：将来要给某个通用关切穿线（例如把取消/超时 signal 送到每一次驱动调用上，
 * 现在 deadline 只在编排循环的头上查一次，一次挂住的驱动调用就穿过去了），只要往这里加一个字段、
 * 在**一处**注入，不用改四个执行器的签名——「同一件事在四条分支各接一遍」正是这次要消灭的形状。
 */
interface StepContext {
  driver: PageDriver
  recipe: CanonicalBrowserRecipe
  params: Record<string, string>
  probe: RunProbe
  observers: ObserverPipeline
  /** 动作步骤产出的 trace 汇总到这里（`openTarget`/`locate`/`evaluate` 不产 trace） */
  trace: ActionTrace[]
  /** 这次运行的硬上限（绝对时刻）；`Infinity` = recipe 没声明 `policy.maxTaskMs` */
  deadlineAt: number
  /** 两次动作之间的最小间隔（ms），0 = 不节流 */
  minInterval: number
  /** 取消信号 */
  signal?: AbortSignal
  /** 拟人节奏的随机种子。**存种子而不是存已经造好的 RandomSource**：现状是每个动作步骤各自
   *  `makeRandom(seed)`，即每步都从同一个种子重新起流；共用一条流会静默改掉每一步的 dwell。 */
  seed: number
  /** `call` 步骤的出口（宿主注入；recipe 只给得出一个服务名，给不出地址）。
   *  缺席 = 这份 recipe 里的 `call` 一步都跑不了，硬失败。见 `recipe.ts` 那一格的头注。 */
  call?: (
    service: string,
    path: string,
    body: { image: string } & Record<string, string | number | boolean>,
  ) => Promise<unknown>
  /** `locate` 步缺省 `ordered` 时的账本（见 `RecipeRunnerOptions.orderedFor`）。 */
  orderedFor?: (facility: string) => string[]
}

/**
 * 通用**前置**闸门：动手之前，等 `settle.selector` 那块区域**画完并停住**（判据是"变过了 +
 * 停住了"，见 `StepSettle`）。
 *
 * 过去只有走 `runActions` 的动作步骤收得到 `settle`——`openTarget` / `locate` / `evaluate` 上
 * 写了照样不生效。那不是设计，是接线漏了：`settle` 的语义是「动作前等目标区域就绪」，而
 * `locate`/`openTarget` 干的事就是"点一张卡"，完全适用。（动作步骤的 `settle` 仍然长在
 * `runActions` 内部，和它的 `expect`/`retryEvery` 绑在一起，这次不动它——所以这道闸门只覆盖
 * 另外三类，不会有人被等两遍。）
 *
 * 没声明 = 一次驱动调用都不发生的空操作，也不留 probe 行：一行 0ms 的空账会被读成"这里还有
 * 一道闸门，只是很快"。`evaluate` 不操作页面、只调站点自己的 JS，通常**没必要**声明它。
 *
 * 超时**不阻断**：它是闸门不是判决（见 `StepSettle.timeout`），到点照常往下走，这一步的成败由
 * 它自己的内建确认 / `expect` 说了算。
 */
async function gateStepSettle(ctx: StepContext, step: { settle?: StepSettle }, index: number): Promise<void> {
  if (!step.settle) return
  const st = await waitForSettle(ctx.driver, step.settle)
  // 一行自述 + 一个 mark：settle 最长能等到 `SETTLE_DEFAULT_MS`，不给它自己的账，这段墙钟就会
  // 记到下一个阶段头上，DebugBox 会指着一个没花时间的阶段说它慢。
  ctx.probe.detail(`step#${index} settle ${st.state} ${st.ms}ms/${st.frames}帧`)
  ctx.probe.mark(`step#${index} settle`)
}

/**
 * `evaluate`：在登录着的页面里调**站点自己的请求客户端**，按它的 cursor 翻页。
 * 页内抛错（风控 body、模块搬家）是 drift，绝不当成一次静默的空 ok。Render-independent，
 * 所以这是唯一能在静默后台 tab 里跑的采集。
 *
 * 数据流和另外三类**不同、且是语义差异不是遗漏**：它自己 `offer` 翻页结果，不走
 * `observe('after-step')`。翻页循环内部**再查一遍** deadline/abort 也是有意的——一次 evaluate
 * 步骤能翻 30 页，循环头查一次管不住它。
 */
/**
 * 一次页内求值，撞上**执行上下文被换掉**就重试一次。
 *
 * `Detached while handling command.` 不是 drift，是**瞬态**：页面在导航后换执行上下文
 * （SPA hydration / renderer 换进程），正在飞的那条 CDP 命令连同它的上下文一起没了。
 * 活体（2026-08-15，douyin-search）：同一份 recipe 连着跑，有的轮次第一发 eval 就撞上、
 * 有的轮次一点事没有——**它偶发，而且只在一个刚建出来的 lane tab 的头几秒里**。
 *
 * **为什么必须在这里挡住，而不是让它冒到上层**：这条错走的是 `EvaluateDriftError`，
 * 而 drift 会把这个源送进 `RepairLedger` 隔离；隔离之后的返回是 `items:0 + errors:[]`，
 * 与「跑成功了但没搜到」**一模一样**（failure-atlas 附录 B.3）。也就是说一次瞬态抖动会让
 * 这个源**从此静默地不再运行**，而没有任何症状指向真因。
 *
 * 只重试这一种错，而且只重一次：recipe 自己抛的业务错（风控、模块搬家）必须立刻失败——
 * 重发一次有副作用的请求不叫重试。
 */
async function evalWithDetachRetry(driver: PageDriver, expr: string): Promise<unknown> {
  try {
    return await driver.evalJson!(expr)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/detached/i.test(msg)) throw e
    await driver.sleep(700)
    return await driver.evalJson!(expr)
  }
}

async function runEvaluateStep(ctx: StepContext, step: EvaluateStep, index: number): Promise<void> {
  const { driver, observers, params, probe } = ctx
  if (!driver.evalJson) throw new Error('recipe requires in-page evaluate capability')
  const pageSize = step.pageSize ?? 20
  const maxPages = step.maxPages ?? 30
  let cursor = ''
  let emptyStreak = 0
  for (let page = 0; page < maxPages && observers.items().length < ctx.recipe.output.targetCount; page++) {
    if (Date.now() > ctx.deadlineAt) throw new Error('recipe deadline exceeded')
    if (ctx.signal?.aborted) throw new Error('recipe cancelled')
    const expr = `(()=>{const __name=(f)=>f;return (${step.call})(${JSON.stringify(cursor)},${pageSize},${JSON.stringify(params)});})()`
    let body: unknown
    try {
      body = await evalWithDetachRetry(driver, expr)
    } catch (e) {
      throw new EvaluateDriftError(e instanceof Error ? e.message : String(e))
    }
    const pending = step.pendingField != null && !!getPath(body, step.pendingField)
    if (!pending) {
      const { fresh } = observers.offer({ items: getPath(body, step.itemsAt) })
      // two consecutive fresh-0 pages = the stream is repeating → stop
      if (fresh === 0 && ++emptyStreak >= 2) break
      if (fresh > 0) emptyStreak = 0
    }
    const next = step.cursorField == null ? null : getPath(body, step.cursorField)
    cursor = next == null ? '' : String(next)
    if (!cursor) break
    await driver.sleep(Math.max(ctx.minInterval, 900 + (page % 3) * 400))
  }
  probe.mark(`step#${index} ${step.kind}`)
}

/**
 * `openTarget`：滚动重试着找到那张卡、点开它、确认真开了，开不成就整页导航回落。
 *
 * 尾标 `step#N open <via>` 把这一步的墙钟和后面 observer 的等待切开，probe（以及渲染 timing 的
 * DebugBox）才说得出**哪一段**慢：打开笔记（in-feed 点击，或滚动重试后一次整页 fallback 导航）
 * vs 等打开的笔记状态就绪（`readyWhen`，记在 `state-wait` 里）。
 */
async function runOpenTargetStep(ctx: StepContext, step: OpenTargetStep, index: number): Promise<void> {
  const { driver, params, recipe, probe } = ctx
  if (!driver.openTarget) throw new Error('recipe requires target-open capability')
  const identity = params[step.identityParam]
  if (!identity) throw new Error(`recipe requires parameter ${step.identityParam}`)
  let opened = false
  let attempts = 0
  for (let attempt = 0; attempt <= (step.maxScrolls ?? 0) && !opened; attempt++) {
    attempts = attempt + 1
    // openTarget returns whether it CLICKED a found target; observeOpened confirms the
    // note actually opened (url carries the id) — same split as the locate step.
    const clicked = await driver.openTarget(step.selector, identity)
    if (clicked) opened = await observeOpened(driver, identity)
    if (!opened && attempt < (step.maxScrolls ?? 0)) {
      await driver.scrollOnce(500 + attempt * 120)
      await driver.sleep(700)
    }
  }
  let via: string
  if (opened) via = `click#${attempts}`
  else if (step.fallbackUrl) { await driver.goto(substitute(step.fallbackUrl, params), recipe.entryWait); via = 'fallback-nav' }
  else throw new Error('target card was not recoverable')
  probe.mark(`step#${index} open ${via}`)
}

/**
 * `locate`：闭环的拟人「找卡 → 点开」。读视口，用有序 noteId 账本（一个运行参数）判方向和距离，
 * 把目标卡挪进视野再点它。替掉 openTarget 那种盲目下滚。
 *
 * 三段各一行 probe，因为它们是三种完全不同的成本，各自要能在 DebugBox 里单独看见：
 *  · `locate`   — **找**卡（账本跳 / 滚动）。
 *  · `humanize` — 拟人点击本身：光标一小步一小步挪到卡上 + 按下松开（`noWaitAfter`，所以不含
 *                 等页面变）。这是反检测的代价，也是这条路径的耗时大头。
 *  · `open`     — **观测**结果：等笔记真的打开（url 出现 noteId）；没等到就是超时 + 回落导航。
 *
 * `open` 之后**没有固定 dwell**。曾经有过一个 `sleep(500)`（自己占一行 `settle` probe），理由是
 * "readyWhen 从条目一存在就是真，gate 不住内容填完没"。2026-07-27 的活体实测（cloak、可信点击、
 * 每 10ms 采一次 `noteDetailMap[noteId]`）证明那个理由**根本是错的**：
 *  · 视频笔记（type:'video'）**分三段**填 —
 *      1ms   note 6 个 key，desc 空，没有 video.media.stream，firstRequestFinish FALSE
 *      148ms note 15 个 key，desc + video.media.stream 到位，firstRequestFinish FALSE
 *      355ms firstRequestFinish TRUE，10 条评论
 *    也就是 `comments.firstRequestFinish` 是**最后**才翻的信号——它落在内容已经完整之后，
 *    所以它是一个有效的（实际上是最严的）闸门。
 *  · 图文笔记（type:'normal'）是**原子**出现的：第一次采样就 14 个 key 全在、firstRequestFinish
 *    为真，10ms 的采样没抓到任何中间态。
 * 所以 observer 自己的 poll-until-readyWhen（+ maxWaitMs）足够了：半成品条目它读成未就绪、继续
 * 轮询，而 observer-pipeline 的 `identity` 过滤会丢掉那个恒在的 `undefined` 占位 key，不会被误
 * 当成就绪条目。盲等只延迟了图文那一档，而它第一次读就已经就绪。现在真正 gate 住读的是 `pollMs`
 * （xhs-detail 里是 50）——把它保持小，offer 才跟得住真正的就绪时刻，而不是一个轮询边界。
 */
async function runLocateStep(ctx: StepContext, step: LocateStep, index: number): Promise<void> {
  const { driver, params, recipe, probe } = ctx
  if (!driver.openTarget) throw new Error('recipe requires target-open capability')
  const identity = params[step.identityParam]
  if (!identity) throw new Error(`recipe requires parameter ${step.identityParam}`)
  let orderedIds: string[] = []
  const passed = params[step.orderedParam]
  if (passed === undefined && ctx.orderedFor) {
    // 调用方没给坐标系：按这份 recipe 的 facility 问账本（见 RecipeRunnerOptions.orderedFor）。
    orderedIds = [...ctx.orderedFor(recipe.session.facility)]
  } else {
    try {
      const parsed = JSON.parse(passed ?? '[]')
      if (Array.isArray(parsed)) orderedIds = parsed.map(String)
    } catch { /* empty/broken ledger → straight to click-attempt then fallback */ }
  }
  // Skim the target card into view, then a trusted click that opens it as an in-feed overlay.
  // A miss (note not in the loaded feed / card not recoverable) falls back to the standalone
  // note nav — same safety net as openTarget.
  probe.detail(`locate: ledger=${orderedIds.length} targetInLedger=${orderedIds.includes(identity)} target=${identity.slice(0, 8)}`)
  const located = await locateCard(driver, step.selector, orderedIds, identity, {
    maxSteps: step.maxSteps,
    trace: (line) => probe.detail(line),
  })
  probe.mark(`step#${index} locate`)
  const clicked = located ? await driver.openTarget(step.selector, identity) : false
  probe.mark(`step#${index} humanize`)
  let opened = false
  if (clicked) opened = await observeOpened(driver, identity)
  let via: string
  if (opened) via = 'locate+click'
  else if (step.fallbackUrl) {
    await driver.goto(substitute(step.fallbackUrl, params), recipe.entryWait)
    via = 'fallback-nav'
  } else throw new Error('locate target was not recoverable')
  // `open` times the OBSERVE — wait-for-the-note-to-open (or deadline + fallback nav).
  // The acceptance label `locate+click` / `fallback-nav` is unchanged (4 skill docs grep it).
  probe.mark(`step#${index} open ${via}`)
}

/**
 * 普通动作步骤：委托 `runActions`。它自带 `settle`（动作前）/ `expect`（动作后，且支持
 * `retryEvery` = 把动作整个重做一遍）——**那个重做语义必须留在动作层面**，提到编排层就丢了，
 * 所以这两道闸门在这条路径上不由编排层接。
 *
 * `onTick` 是 runActions 在长动作（scroll）**中途**回调的钩子：查取消/超时、查登录墙、
 * 让 observer 读一次。它无状态，每步现造一个和过去共用一个完全等价。
 */
async function runActionStep(ctx: StepContext, step: RecipeAction, index: number): Promise<void> {
  const { driver, observers, recipe, probe } = ctx
  const onTick = async () => {
    if (ctx.signal?.aborted) throw new Error('recipe cancelled')
    if (Date.now() > ctx.deadlineAt) throw new Error('recipe deadline exceeded')
    if (recipe.loginCheck.challenge && await driver.exists(recipe.loginCheck.challenge)) throw new ChallengedError()
    if (await driver.exists(recipe.loginCheck.wall)) throw new WalledError()
    await observers.observe('after-step')
  }
  const stepTrace = (await runActions([step], driver, makeRandom(ctx.seed), {
    get done() { return observers.items().length >= recipe.output.targetCount },
    get size() { return observers.items().length },
  }, {
    cookieDomain: recipe.cookieDomain, params: ctx.params, entryWait: recipe.entryWait, onTick, stepIndex: index,
    // `call` 那一格要的两样：出口（宿主注入）+ 这份 recipe 申报过的副作用（没申报不许跑）。
    call: ctx.call, effects: recipe.meta?.effects,
  })).map((t) => ({ ...t, step: index }))
  // The scroll step is one probe phase but usually the whole run's wall-clock — surface
  // its per-scroll breakdown so the dominant cost isn't an opaque block.
  for (const t of stepTrace) {
    const s = t.scroll
    if (s) probe.detail(`step#${index} scroll  n=${s.scrolls} dwell ${(s.dwellMs / 1000).toFixed(1)}s atBottom ${s.atBottomRounds}  items ${s.sizeCurve.join(',')}  (${s.stopReason.replace('scroll stop: ', '')})`)
    /**
     * **settle 没等到判据就单独出声。** 它不致命——等满上限（缺省 `SETTLE_DEFAULT_MS` = 15s）
     * 之后照常放行，所以一个写错的 settle 的全部症状就是"这一步很慢"，而那段墙钟被折进本步的
     * 耗时里，DebugBox 上看起来像动作本身慢。活体（2026-09-03）：东财登录的 `call` 步两次运行
     * 都是 15.0s+，而识别本身实测 10ms、容器还是醒着的——真因是 settle 空等，一条日志都没有。
     *
     * 非动作步骤那一侧（`gateStepSettle`）本来就每次都自述；这里补的是动作步骤那一半。
     */
    const stalled = /settle (?:timeout|absent|unsupported) \d+ms\/\d+帧/.exec(t.note ?? '')
    if (stalled) probe.detail(`step#${index} ${stalled[0]} ← 没等到判据，照常放行`)
  }
  ctx.trace.push(...stepTrace)
  probe.mark(`step#${index} ${step.kind}`)
}

/** Executes a canonical recipe against an already-owned session. Tab lifetime stays
 * in RecipeSessionManager so this runner is reusable across every facility. */
export class RecipeRunner {
  /** `newProbe` is injectable so bootstrap can light probing up in dev while tests/prod
   *  stay silent (default = a disabled probe: timing still collected, no RSS, no logs).
   *  `onLiveItems` (optional) receives each freshly-scraped batch mid-run for the live
   *  harvest preview stream; bootstrap normalizes + broadcasts them. */
  constructor(
    private readonly newProbe: (sourceId: string) => RunProbe = (id) => new RunProbe(id, false),
    private readonly onLiveItems?: (sourceId: string, items: MappedItem[]) => void,
    /** fired once when the run finishes (any outcome) — ends the live preview's "采集中".
     *  On the runner (not scheduler.onOutcome) so it fires for PREVIEW runs too, which
     *  never record health / call onOutcome. */
    private readonly onLiveDone?: (sourceId: string) => void,
    /** fired once when the run finishes (any outcome) with its per-phase timing + item count —
     *  bootstrap turns it into a DebugEntry so every recipe run (detail included) shows its step
     *  breakdown in the DebugBox, not just the discover harvest. */
    private readonly onRunProbe?: (sourceId: string, timing: PhaseTiming[], itemCount: number) => void,
    /** 失败现场（截图 + 文本 + trace）。bootstrap 把它落成 DebugEntry，人不用重跑一次就能看见
     *  当时页面长什么样 —— one-shot 的 tab 失败即关，现场只有这一次机会。 */
    private readonly onFailureScene?: (
      sourceId: string,
      scene: FailureScene & { reason: string; trace: ActionTrace[] },
    ) => void,
    /**
     * `call` 步骤的出口。**注入在这里而不是让 recipe 自己拼地址**，是那一格第 1 条边界的
     * 落点：recipe 是能从 npm 装的第三方数据，给它拼 URL 的能力就是给它一个外泄原语。宿主
     * 拿 `service` 去解析本包声明的后端（`/_p/<service>`），解析不到就抛。
     * 不注入 = 带 `call` 的 recipe 一步都跑不了（硬失败，不是静默跳过）。
     */
    private readonly call?: (
    service: string,
    path: string,
    body: { image: string } & Record<string, string | number | boolean>,
  ) => Promise<unknown>,
  ) {}

  async run(
    recipe: CanonicalBrowserRecipe,
    params: Record<string, string>,
    driver: PageDriver,
    opts: RecipeRunnerOptions = {},
  ): Promise<RecipeRunOutcome> {
    if (opts.signal?.aborted) return { outcome: 'cancelled', items: [], trace: [], reason: 'aborted before start' }
    const probe = this.newProbe(recipe.sourceId)
    const stateGraph = assembleGraph(BUILTIN_STATES, opts.stateGraph)
    // 一趟的介入次数就在这一趟的作用域里数（`run` 可以并发跑很多趟，计数放到实例上就会串味）。
    const repairBudget = opts.repairBudget ?? DEFAULT_BUDGET.repairs
    let asks = 0
    const takeAsk = (): boolean => {
      if (asks >= repairBudget) {
        probe.detail(`介入预算已用完（${repairBudget}/${repairBudget}），这次不问`)
        return false
      }
      asks += 1
      return true
    }
    // 抽取状态挂到每一条出口上（含 drift/blocked）：抽取跑在 harvest 判定之前，"key 抓到了没有"
    // 和"这次采到几条"是两件独立的事，不能因为后者失败就把前者的结论吞掉。
    let extractNote: string | undefined
    const withExtract = (out: RecipeRunOutcome): RecipeRunOutcome =>
      extractNote ? { ...out, extract: extractNote } : out
    // entryUrl may template run params (e.g. a note-detail page /explore/{noteId}) — a
    // literal {hole} navigates to a bogus path (the site's 404), so substitute before
    // any goto and before comparing against the current location.
    const entryUrl = substitute(recipe.entryUrl, params)
    // A persistent tab may be anywhere after a previous run (a search results page, a
    // failed detail open) — re-enter the recipe's entry context before probing login,
    // or the observers would read a foreign page as this recipe's output.
    // `rideCurrentPage` opts OUT: the tab already holds the feed the target came from, and
    // an openTarget step clicks the card there (its identity-match + fallbackUrl replace
    // this safety — a foreign page just means the card isn't found → fallback nav).
    // 只有 recipe 明确声明「凭证从响应正文里取」，才装那条正文旁路（见 RawBodySink）。
    // 收集器活在这一次运行的作用域里，运行一结束就随它一起消失——不落盘、不进 items、不进 trace。
    const wantsNetworkSecret = recipe.extract?.from?.network != null
    const capturedBodies: Array<{ url: string; text: string }> = []
    const observers = new ObserverPipeline(driver, recipe.observers, recipe.output, {
      ...opts, params,
      onItems: this.onLiveItems ? (items) => this.onLiveItems!(recipe.sourceId, items) : undefined,
      onRawBody: wantsNetworkSecret ? (url, text) => { capturedBodies.push({ url, text }) } : undefined,
      secretCapture: recipe.extract?.from?.network,
    })
    // A network observer can only report responses that arrive AFTER it is attached, so it must be
    // listening BEFORE the entry page loads — otherwise the first batch (fetched during page load)
    // is invisible and the harvest survives only on whatever a later scroll happens to re-fetch.
    // That made a fresh-tab harvest nondeterministic: a scroll that triggered no new request
    // harvested nothing at all (an empty 推荐 refresh).
    const capturesLoad = recipe.observers?.some((o) => o.kind === 'network') ?? false
    const seed = crypto.randomInt(0, 2 ** 31 - 1)
    const deadlineAt = recipe.policy?.maxTaskMs != null ? Date.now() + recipe.policy.maxTaskMs : Infinity
    const minInterval = recipe.policy?.minActionIntervalMs ?? 0
    const trace: ActionTrace[] = []
    let restorePending: 'back' | 'entry' | undefined
    /**
     * `rideCurrentPage` 的**工作上下文 = 进场时标签停在哪**，不是 `entryUrl`。
     *
     * 为什么不能拿 `entryUrl` 当落点（2026-07-28，账本来源从 homefeed 换成 search 之后）：
     * xhs-detail 的 `entryUrl` 写的是 `/explore`（当年的 feed），而现在它骑的是**搜索结果页**。
     * 拿 `/explore` 做落点判据，每次 detail 跑完都会把标签从搜索结果导航去推荐流——而账本记的是
     * 搜索那一批，推荐流里一条都不认识 → 下一次 `known=0` → MISS → 整页导航 → 又回推荐流。
     * 一次"清理"就把后面每一次 detail 都变成 fallback-nav（有数据、不报错，最难查的那种坏）。
     *
     * 两道闸门，都在防"把一个不该当家的页面认成家"：
     * - **同源**才收。`about:blank`（冷启的标签）origin 是 `null`，直接出局——那正是
     *   99b8c55f 修掉的自我延续循环的起点。
     * - **不能是这次的 `fallbackUrl` 目标**。上一次运行失败可能把标签停在笔记页上；把笔记页
     *   认成 feed，等于"`entryUrl` 和 `fallbackUrl` 填成一样"那个已知的坑换了个形状复活。
     */
    let ridingFrom: string | null = null
    const fallbackTargets = (recipe.steps ?? [])
      .map((s) => ('fallbackUrl' in s && s.fallbackUrl ? substitute(s.fallbackUrl, params) : null))
      .filter((u): u is string => u != null)
    const acceptRidingFrom = (here: string | null): string | null => {
      if (!here) return null
      try {
        if (new URL(here).origin !== new URL(entryUrl).origin) return null
      } catch {
        return null
      }
      return fallbackTargets.some((u) => onEntryPage(here, u)) ? null : here
    }
    /**
     * 把 tab 放回这个 recipe 的工作上下文。
     *
     * `back` **之后要看一眼落在哪**：历史栈上一个不一定是 entry 的上下文。活体实测的自我延续
     * 循环就长这样——cloak 冷启的 tab 是 `about:blank`，detail 骑着它跑（`rideCurrentPage`）→
     * locate 在空白页上找不到卡片 → 整页导航到 `fallbackUrl` → `back` 又回到 `about:blank` →
     * 下一次还是从空白页开始。落点不对就补一次 `goto(entryUrl)`，把循环打断在这里。
     *
     * **为什么是 back 优先、只在落点不对时才 goto**，而不是无条件 goto：
     *
     * |            | overlay 命中时      | fallback 之后              |
     * |------------|---------------------|----------------------------|
     * | `back`     | 0 次导航（关浮层）  | 1 次 back（bfcache，账本保住）|
     * | 无条件 goto | 1 次整页导航        | 1 次整页导航               |
     *
     * 整页导航是唯一会压崩渲染进程的操作，而 feed 每次加载推荐内容都不同——无条件 goto 等于给
     * 每一次 detail 都加一次导航 + 把账本冲掉，反而把崩溃风险抬高。
     *
     * 报不出 URL 的驱动（`currentUrl` 缺席）**不猜**：维持原行为不导航，和 `observeOpened` /
     * 入场判断对这类驱动的处理一致。
     */
    const restore = async (attempt: (fn: () => Promise<void>) => Promise<void>) => {
      const pending = restorePending
      restorePending = undefined
      if (pending === 'back') {
        await attempt(async () => {
          // back 自己失败不该吞掉兜底——落点确认才是这条路要保证的事。
          await driver.back().catch(() => {})
          const here = driver.currentUrl ? await driver.currentUrl().catch(() => null) : null
          // 落点 = 骑进来的那个 feed（rideCurrentPage 且这个 feed 认得出来时），否则 entryUrl。
          const landing = ridingFrom ?? entryUrl
          // 落点确认这一次 goto **自己吞错**，和它上面的 back() 对称。它是"给下一次运行准备
          // 环境"的尽力而为，此刻采集已经跑完（item 拿到了、落点多半也已经回对了）；而
          // `interrupted by another navigation` 这类错在真浏览器上是常态——SPA 自己的路由跳转、
          // back 的导航尾巴、页面自身的重定向都会撞上，且撞上了也不代表落点是错的（活体实测
          // 2026-07-27：报了这个错，页面确实停在 /explore，HTTP 却成了 502）。
          // 它失败最坏的后果是下次运行落在 foreign page 上、退回 fallback-nav —— 降级，不是灾难。
          // 和 captureScene 头注「取证失败绝不能盖掉真正的失败原因」是同一条原则的两面：
          // **清理失败同样不能盖掉一次成功的采集。**
          // 只吞这一步：`'entry'` 分支那次 goto 是 recipe 显式声明的动作，失败照旧冒出去。
          if (here && !onEntryPage(here, landing)) await driver.goto(landing, recipe.entryWait).catch(() => {})
        })
      } else if (pending === 'entry') await attempt(() => driver.goto(entryUrl, recipe.entryWait))
    }
    /**
     * `openTarget` / `locate` 的通用后置。
     *
     * 这两条分支的尾巴过去是**逐字重复的两份**：`expect` 闸门当初就是这么接上去的（在两条分支里
     * 各插一遍相同的 8 行），于是"所有 step 都该有的东西"每加一样就要在两处各接一遍——漏一处就是
     * 一个"写了、加载不报错、运行不报错、就是不干活"的字段。合成一处，加能力只加一处。
     *
     * 四步的顺序都是承重的：
     *  1. **restore 先登记、再过闸门** —— `expect` 失败也要把 feed 上下文还回去（含 `fallback-nav`
     *     那条路），别把复用的 tab 停在目标页上。
     *  2. `expect` 跑在这两步各自的**内建确认之后**（内建确认答"打开了没"，`expect` 答"打开的是不是
     *     我要的那个"）——见 `gateStepExpect`。`fallback-nav` 那条路同样要过：判的是最终状态，
     *     不是走哪条路到的。
     *  3. 且必须跑在 `observe('after-step')` **之前**：observer 从一个错的页面上读走的是真数据、
     *     只是来自别处，这是最难查的一类错。
     *  4. 只有真声明了 `expect` 才留一行账：一行 0ms 的空账会被读成"这里还有一道闸门，只是很快"。
     */
    const finishOpenStep = async (index: number, step: { restore?: 'back' | 'entry'; expect?: StepExpect }) => {
      restorePending = step.restore
      if (step.expect) {
        await gateStepExpect(driver, index, step.expect)
        probe.mark(`step#${index} expect`)
      }
      await observers.observe('after-step')
      probe.mark(`step#${index} state-wait`)
    }
    // 每个执行器拿到的同一份上下文（见 StepContext）。**一处装配**，所以往执行器里送一样新东西
    // 只改这里 + 那个接口，不用挨个改签名。
    const ctx: StepContext = {
      driver, recipe, params, probe, observers, trace, deadlineAt, minInterval, signal: opts.signal, seed,
      call: this.call,
      orderedFor: opts.orderedFor,
    }
    try {
      await observers.start()
      // Enter the recipe's page only now that the observers are listening. A persistent tab may be
      // anywhere after a previous run (a search page, a note left open by a fallback), so re-enter
      // unless the recipe rides the current page. `capturesLoad` forces the load even when we are
      // already on the entry URL: a network observer needs to WATCH that load happen.
      if (opts.adoptedTab) {
        // the user's own tab: live page, nothing to (re)load — see RecipeRunnerOptions.adoptedTab
      } else if (!recipe.rideCurrentPage) {
        const here = driver.currentUrl ? await driver.currentUrl() : null
        // A persistent lane already parked on the entry page is a render from the PREVIOUS run:
        // the site moved on since (a chat gained new images, a feed gained new posts) and reading
        // the parked copy hands back last time's answer (doubao-chat-images: two runs, same guid).
        // So "already here" is a reason to reload, not to skip — only `rideCurrentPage` gets to
        // keep the page as it is, and it says so.
        const parked = recipe.session.lifecycle === 'persistent' && here != null && onEntryPage(here, entryUrl)
        if (capturesLoad || parked || (here && !onEntryPage(here, entryUrl))) await driver.goto(entryUrl, recipe.entryWait)
      } else {
        // 记下骑进来的是哪一页——它才是这次运行的工作上下文（见 ridingFrom 的注释）。
        ridingFrom = acceptRidingFrom(driver.currentUrl ? await driver.currentUrl().catch(() => null) : null)
      }
      probe.mark('entry')
      const loginState = await detectLoginState(driver, recipe.loginCheck)
      probe.mark('login')
      // `runAtWall` 只松开**入场**这一次：登录 recipe 降落的那一页按定义就是墙，不松开它
      // 连动手的机会都没有。跑完之后的复判（下面那处）照旧——登录失败就还留在墙上，如实报
      // needsLogin。挑战不松：站方风控对登录同样是"停下等冷却"。
      if ((loginState === 'WALLED' && !recipe.loginCheck.runAtWall) || loginState === 'CHALLENGED') {
        this.onLiveDone?.(recipe.sourceId)
        return loginState === 'CHALLENGED'
          ? { outcome: 'challenged', items: [], trace: [], reason: '进场时站方正在挑战（风控）', timing: probe.timings() }
          : { outcome: 'needsLogin', items: [], trace: [], timing: probe.timings() }
      }
      await observers.observe('entry')
      probe.mark('setup')
      let lastActionAt = 0
      /**
       * `expect.retryFrom` 的账本：**键是那个宣告重来的步骤**，不是被重跑的那些步。
       * 一段里可以有两处各自宣告重来（今天没有，但结构上不该互相扣次数）。
       */
      const groupAttempts = new Map<number, number>()
      /**
       * 哪几格已经为了清全局障碍逃过一次。**独立于 `groupAttempts`**：那一本是 `retryFrom`
       * 的配额，让一次逃生悄悄吃掉一次重试，会表现成「为什么只重试了两次」，而没有任何
       * 一处说得出原因。
       */
      const escaped = new Set<number>()
      // 索引式循环（不是 `.entries()`）：`retryFrom` 要能把游标拨回去。别改回 for-of。
      for (let index = 0; index < recipe.steps.length; index++) {
        const step = recipe.steps[index]
        // ── 通用前置。每一样只出现一次；加一条"所有 step 都该有"的能力就加在这里，
        //    而不是去四条分支里各接一遍（那正是 settle 漏掉、expect 差点漏掉的原因）。 ──
        if (Date.now() > deadlineAt) throw new Error('recipe deadline exceeded')
        // 取消检查和 deadline 并列在这里，不在各执行器里：**每一步的边界都是一次可退出点**。
        // 长动作（scroll）和分页循环各自还有一次中途检查，那是它们内部的事；这一处管的是
        // "上一步刚做完、下一步还没开始"——被放弃的详情最常停在这里。
        if (opts.signal?.aborted) throw new Error('recipe cancelled')
        if (minInterval > 0 && lastActionAt > 0) {
          const wait = minInterval - (Date.now() - lastActionAt)
          if (wait > 0) await driver.sleep(wait)
        }
        lastActionAt = Date.now()
        // 动作步骤先走：它的 settle/expect 长在 runActions 内部（`expect.retryEvery` 要"把动作
        // 整个重做一遍"，那个能力只有动作层面有），所以它不过下面这道 settle 闸门。
        if (isActionStep(step)) {
          try {
            await runActionStep(ctx, step, index)
          } catch (e) {
            // 整段重来：这一步的判据没满足（`StepExpectError`），**或者它拿回来的结果不合格**
            // （`StepResultError`，如 call 的 match 没过），而这份 recipe 说了"回到第 N 步再走
            // 一遍"。原型是图形验证码——识别错了、或提交被拒，那张图都已经作废，只重做当前这
            // 一步是纯空转，必须回到"刷新图 → 重认 → 重填"。见 recipe.ts 的 retryFrom 头注。
            //
            // **读的是步骤自己的 `retryFrom`，不是 `step.expect.retryFrom`。** 两种失败一直
            // 是一视同仁的，但字段曾经长在 `expect` 里，于是没有 expect 的 `call` 步根本没地
            // 方声明重试——它的失败照样落进这个 catch，`from` 却恒为 undefined，直接抛出去。
            // **先看是不是撞上了全局障碍**，它比 recipe 自己的 retryFrom 更具体。
            //
            // 障碍在场意味着**页面已经被替换了**，这一步根本没作用在目标页上——所以它没有
            // 副作用，清掉之后重做**这一步**（不是整段）是正确的。这与 spec §6「不在同一趟里
            // 重走」不矛盾：那条说的是 **AI 提议之后**不重走，那时动作可能已经生效。
            if (e instanceof StepExpectError) {
              const verdict = await classifyByState(ctx.driver, stateGraph, opts.onObserved)
              // 认不出就把这一刻的现场交出去（spec §4）。放在死路判断**之前**：下面几条
              // 分支都会 throw / continue，挂在它们后面等于只有一条最窄的路会交。
              await handOffVerdict(
                opts.repairRunner, verdict, ctx.driver, stateGraph,
                recipe.sourceId, recipe.session.facility, recipe.entryUrl, `第 ${index} 步 expect 落空`,
                takeAsk,
              )
              // 死路：立刻停，而不是等防转圈撞满、或把这一趟的时间耗光。
              if (verdict.kind === 'deadEnd') throw new StateDeadEndError(verdict.state, verdict.reason)
              if (verdict.kind === 'escapable' && !escaped.has(index)) {
                const moves = verdict.escape.steps.filter(isEscapeStep)
                // 一条都认不出形状 = 这条逃生口是坏的。**别白跑一次重试**，落进下面的常规处置。
                if (moves.length > 0) {
                  // **每一格最多清一次。** 清完还在就不是"没点中"，是"清不掉"——再清一次只是
                  // 把同一件事重做一遍，而真正该发生的是干净地停下来。
                  escaped.add(index)
                  probe.detail(`escape  step#${index} 撞上 ${verdict.state}，清掉后重试这一步`)
                  for (const m of moves) await runEscapeStep(ctx.driver, m)
                  index = index - 1 // 循环末尾的 ++ 会把它推回本步
                  continue
                }
              }
            }
            const from = step.retryFrom
            const retryable = e instanceof StepExpectError || e instanceof StepResultError
            if (retryable && from !== undefined) {
              const done = (groupAttempts.get(index) ?? 0) + 1
              if (done < (step.retryTimes ?? 1)) {
                groupAttempts.set(index, done)
                probe.detail(`retry   step#${index} 整段重来（回到 step#${from}，第 ${done + 1} 次）`)
                index = from - 1 // 循环末尾的 ++ 会把它推到 from
                continue
              }
            }
            throw e
          }
          continue
        }
        await gateStepSettle(ctx, step, index)
        if (step.kind === 'evaluate') {
          await runEvaluateStep(ctx, step, index)
          continue
        }
        // openTarget / locate：自有逻辑各自成执行器，尾巴（restore 登记 / expect 闸门 /
        // observe / state-wait）是共用的通用后置。
        await (step.kind === 'openTarget' ? runOpenTargetStep(ctx, step, index) : runLocateStep(ctx, step, index))
        await finishOpenStep(index, step)
      }
      // 一次性抽取紧跟在动作之后：值只在这一屏存在（刚建好的 key，关掉再也拿不到），而且
      // 建 key 这类 recipe 通常一条 item 都不产 —— 放在 harvest 判定之后就永远轮不到它。
      if (recipe.extract) {
        // 从响应正文里取的那一档，得先把在飞的 body 读完 —— 否则"刚点完复制"那一条多半还没落地，
        // 抽取会报 0 处而真因只是早了一步。页面文本那一档不受影响：它读的是当下这一屏。
        if (wantsNetworkSecret) await observers.flush()
        extractNote = await captureSecret(recipe.extract, driver, opts.onExtract, wantsNetworkSecret ? () => capturedBodies : undefined)
        probe.detail(`extract  ${extractNote}`)
        probe.mark('extract')
      }
      await observers.flush()
      await observers.observe('final')
      await restore(async (fn) => { await fn() })
      probe.mark('harvest')
      const items = observers.items()
      if (items.length === 0) {
        const drift = observers.driftReason()
        if (drift) throw new EmptyHarvestError('drift', drift)
        // A probe recipe (allowEmpty) treats "nothing harvested" as a legitimate ok result —
        // a dead/empty share is data, not a source failure. Drift above still wins, so a moved
        // response shape is never masked as an empty target.
        if (recipe.allowEmpty) return withExtract({ outcome: 'ok', items, trace, timing: probe.timings() })
        // Name WHERE it ended up and WHAT the observers saw — an empty harvest is otherwise
        // indistinguishable from a page that never loaded, a moved shape, or a missing identity.
        const at = driver.currentUrl ? await driver.currentUrl().catch(() => undefined) : undefined
        const notes = observers.diagnostics()
        const detail = [at ? `at ${at}` : null, ...notes].filter(Boolean).join('; ')
        throw new EmptyHarvestError('blocked', `recipe produced no items${detail ? ` (${detail})` : ''}`)
      }
      probe.summary(items.length)
      return withExtract({ outcome: 'ok', items, trace, timing: probe.timings() })
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error)
      let outcome: RecipeRunOutcome['outcome'] =
        opts.signal?.aborted || reason === 'recipe cancelled' ? 'cancelled'
        : error instanceof ChallengedError ? 'challenged'
        : error instanceof WalledError ? 'needsLogin'
        // 死路是**站方让我们停**，不是我们写错了：走 challenged 那条（等冷却），绝不进 drift。
        : error instanceof StateDeadEndError ? 'challenged'
        // 空收成自带结论（drift / blocked），但仍要走完下面那套认领现场——它只是换了个出口。
        : error instanceof EmptyHarvestError ? error.outcome
        : error instanceof FeatureDriftError || error instanceof EvaluateDriftError ? 'drift'
        : 'blocked'
      // **失败之后补一次撞墙探测。** 登录墙/拦截页只在 entry 那一刻看过一次，而**它多半是被
      // 动作引出来的**：entry（首页）好好的，step#0 一发搜索就跳到拦截页。少了这一探，一次
      // 「被站点拦下」只会报成一句含糊的 `step#0 expect 未满足：… 没有出现`——两件事的处置
      // 完全相反（该退让 vs 该修选择器），却长得一模一样。
      //
      // 2026-08-13 活体：连打约一百发之后 Google 开始回 `/sorry/index`（`form#captcha-form` 在、
      // `#rso` 不在），六发查询全报 expect 未满足，没有任何一处说出"被拦了"。
      //
      // **`drift` 也要补这一探**（2026-08-15 扩到这一档，原来只补 `blocked`）。理由不是"顺手多探
      // 一次"，是这两条的**处置完全相反、代价却极不对称**：
      //  · 判成 drift → `RepairLedger` 连着几次就把这个源**隔离**，此后返回 `items:0 + errors:[]`
      //    ——和「跑成功了、但确实没搜到」**一模一样**（failure-atlas 附录 B.3）。也就是站方让我们
      //    等一会儿这件事，会把这个源**永久地、静默地**关掉，而且顺带污染 drift 账本本身，
      //    让「选择器漂了」这个信号一起失去意义。
      //  · 判成 needsLogin → facility 冷却（底数与封顶由该站点的撞墙台账喂，见 `FacilityCooldown`），
      //    到点自己回来。语义也对得上：**这不是我们写错了选择器，是站方让我们等。**
      // 活体（douyin-search，同日）：风控挑战让 evaluate 抛错 → drift → 三次之后源被隔离，
      // 下一发 0.005s 秒回空。
      //
      // **只有阳性的墙/挑战才翻案**（`detectLoginState` 回 WALLED / CHALLENGED）。`UNKNOWN`
      // （登录信号一时没渲染、但没有墙）**不翻**——那会把真 drift 伪装成"等一等"、跳过隔离，
      // 方向反了。cancelled/needsLogin/challenged 已经有结论，不补。
      // **回头按状态图认一眼。** 排在下面那段撞墙探测**之前**：全局图认得出的东西（CF 三档）
      // 比 `loginCheck.wall` 更具体，先问具体的再问笼统的——同 `actions.ts` 里「挑战排在墙
      // 前面」那条。认不出就原样落进下面那段，一行都不改。
      if (outcome === 'blocked' || outcome === 'drift') {
        const verdict = await classifyByState(driver, stateGraph, opts.onObserved)
        // 和步级那一处各交各的：中间隔着 retry / 逃生 / 撞墙探测，页面完全可能已经不是
        // 同一张了。合并成一条会把其中一张现场永久丢掉。
        await handOffVerdict(
          opts.repairRunner, verdict, driver, stateGraph,
          recipe.sourceId, recipe.session.facility, recipe.entryUrl, `整趟判 ${outcome}`,
          takeAsk,
        )
        // **本地图认出来的 `escapable` 也照翻 `challenged`。** 判据是「作者写了逃生口」＝
        // 「这是一个被认出来的障碍」，不是「选择器漂了」——两者的处置代价极不对称：判 drift
        // 会让 `RepairLedger` 把源静默隔离，判 challenged 只是等一次冷却。
        if (verdict.kind === 'deadEnd' || verdict.kind === 'escapable') {
          // **必须是 `challenged`。** 判 `drift` 会让 `RepairLedger` 连着几次把这个源隔离，
          // 此后它返回 `items:0 + errors:[]`——和「跑成功了、但确实没搜到」一模一样，
          // 于是一次风控挑战会把源**永久地、静默地**关掉（同下面那段的理由）。
          outcome = 'challenged'
          reason = verdict.kind === 'deadEnd' ? `${verdict.state}：${verdict.reason}` : `${verdict.state}：${reason}`
        } else if (verdict.kind === 'identified' || verdict.kind === 'ambiguous') {
          // **只补一句话，不动结论。** `identified` 说的是「落在了一个已知状态」，而那多半是
          // recipe 自己图里的普通状态（该在列表页、结果落在首页）——那是漂了，不是被挑战，
          // 翻成 `challenged` 会让 facility 白白进冷却。`ambiguous` 同理：它是「哪条特征写松了」
          // 的信号，不是关于站点的结论。名字仍然要说出来，那是排查时唯一的抓手。
          const who =
            verdict.kind === 'identified'
              ? verdict.states.join('、')
              : `同组多命中（${verdict.candidates.join('、')}）`
          reason = `${reason}（状态图认出：${who}）`
        }
      }
      if ((outcome === 'blocked' || outcome === 'drift') && recipe.loginCheck?.wall) {
        const state = await detectLoginState(driver, recipe.loginCheck).catch(() => 'UNKNOWN' as const)
        if (state === 'CHALLENGED') {
          outcome = 'challenged'
          reason = `站方在动作之后弹出风控挑战：${reason}`
        } else if (state === 'WALLED') {
          outcome = 'needsLogin'
          reason = `拦截页/登录墙出现在动作之后：${reason}`
        }
      }
      // 现场取证：**在 restore / 释放 lease 之前**抓。一次 one-shot 运行失败后 tab 立刻关掉，
      // 现场就没了 —— 剩下一句 reason，而 reason 只说"什么没发生"，从不说"当时页面是什么样"。
      // 排查 groq 那条链路的整整一晚，每一次弯路都是从这里开始的：看不见，就只能猜。
      const scene = outcome === 'cancelled' ? undefined : await captureScene(driver, recipe.entryUrl)
      // best-effort context restore — a failed detail open must not leave the
      // persistent tab parked on the target page for the next lease
      await restore(async (fn) => { await fn().catch(() => {}) })
      if (scene) this.onFailureScene?.(recipe.sourceId, { ...scene, reason, trace })
      return withExtract({ outcome, items: observers.items(), trace, reason, timing: probe.timings(), scene })
    } finally {
      await observers.stop()
      this.onLiveDone?.(recipe.sourceId)
      this.onRunProbe?.(recipe.sourceId, probe.timings(), observers.items().length)
    }
  }
}
