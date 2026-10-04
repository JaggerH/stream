/**
 * `run_action_recipe` —— 跑一条**动作型** recipe（跑完不产内容，只是把一件事做了，如
 * `packages/qq/qq-send.recipe.json` 发一条消息）。
 *
 * 仓库里绝大多数 recipe 是**采集**：`pick_in`（`src/manifest/pick.ts`）让它们能在选择面被挑到，
 * 调度器跑它们。动作型 recipe 反过来——它们 `pick_in: []` + `capabilities: []`，任何选择面都挑
 * 不到，于是在这个工具出现之前**没有任何调用方**，是死代码。这个模块就是那个入口。
 *
 * 四条硬约束（不是这里决定的，是调用方——`tool-catalog.ts` 的 `run_action_recipe`——的产品
 * 决定，这里只负责落实）：
 *  1. **必须显式 opt-in**：只跑 `recipe.meta?.action === true` 的 recipe。绝不能从
 *     `pick_in:[]` 之类的字段推——那会让「以后每一条恰好没填 pick_in 的 recipe」悄悄变成可被
 *     模型执行的动作，没有任何一处会报错。见 `RecipeMeta.action` 头注（`../replay/recipe.ts`）。
 *  2. **一律要二次确认**：不带 `confirmed:true` 不执行，返回 `needs-confirmation` + 这次到底
 *     会做什么（sourceId / 解析后的 params / recipe 的 description）。同仓库 `cdp_act` 对高危
 *     动作是同一个形状（`shared/browser-relay/interactive-gate.ts` 的 `ActResult`）。
 *  3. **参数按 recipe 自己的 `meta.params_schema` 校验**，复用 `validate-params.ts`，不另写一份。
 *  4. **找不到 / 不是动作 / 没有 Stream Desktop，三种失败分得开**，各自的 `reason` 说清下一步该
 *     干什么。
 *
 * 执行路线接了两档，各自照抄 `ReplayAdapter` 里那条已经在跑的路，不另起炉灶：
 *
 * - `kind:'desktop'`：拿 `desktopDriver()`，没连 agent 报 `no-desktop`；连了走 `runDesktopRecipe`。
 * - `kind:'browser'`：走 `SessionRecipeExecutor.execute` —— 也就是采集用的那同一个入口，因此
 *   凭据注入的五道闸、facility 限速、退让冷却、lane 租约全部自动成立。**这一档必须走它**，
 *   自己拿 transport 直接跑等于把那几道闸全绕过去，而绕过去之后没有任何一处会喊。
 *
 * 两档的"物理副作用"不是同一件事，所以确认回执里也分开说：桌面档抢前台窗口（`screenTakeover`），
 * 浏览器档不抢屏幕，但它在**用户自己那个 Chrome、带着用户真实登录态**上动手（`targetSite`）。
 * 其它 kind 出现动作 recipe 时再按各自的执行路线接，不在这里预先猜。
 *
 * **有意不接 `RepairLedger`**：`ReplayAdapter.runDesktop` 那条采集路径上 drift/success 都会记进
 * ledger（连续 drift 会把源隔离，等 Code Agent 修复）。这里的执行成功/drift 一律不记——隔离是
 * 为了防止一个坏掉的**采集**源反复空跑浪费资源，而这里每一次都是用户手动确认过的**一次性**
 * 动作，没有"下一次自动重跑"这回事，隔离一条手动动作没有意义。别把这理解成漏接。
 */
import { isCanonicalBrowserRecipe, type CanonicalBrowserRecipe, type Recipe } from '../replay/recipe.ts'
import type { EventInput } from '../events/store.ts'
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { SeeResolver } from '../replay/desktop-see.ts'
import type { RecipeRunOutcome } from '../replay/recipe-runner.ts'
import { runDesktopRecipe, type OverrideSource } from '../replay/desktop-runner.ts'
import { HostRelayDisconnected, HostRelayTimeout, HostSessionQueueTimeout, HostAbortedByUser, INTERACTIVE_SESSION_WAIT_MS } from '../http/host-relay.ts'
import { SESSION_BUSY_REASON, USER_ABORTED_REASON } from '../replay/desktop-failure.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import { materializeParams, validateParams, type ParamEnv } from './validate-params.ts'
import { spillArtifacts } from './action-artifacts.ts'
import { actionRunKey } from './action-run.ts'

export interface ActionRecipeArgs {
  sourceId: string
  params?: Record<string, unknown>
  /** 二次确认闸——不带这个（或 false）时工具只回执"会做什么"，不执行。 */
  confirmed?: boolean
}

export type ActionRecipeStatus =
  | 'needs-confirmation'
  | 'done'
  /** 异步壳（`action-run.ts`）专用：动作还在执行，`runId` 去 `get_agent_run` 轮询。这个模块自己
   *  的同步路径永远不产它——它只出现在经 `createActionRunService` 转发的那条路上。 */
  | 'running'
  | 'not-found'
  | 'not-action'
  | 'invalid-params'
  | 'unsupported-kind'
  | 'no-desktop'
  /** 浏览器档专用：用户的 Chrome / 扩展没连着。和 `no-desktop` 分开——下一步不一样
   *  （那个是去启动 Stream Desktop，这个是去把 Chrome 打开、确认扩展连上）。 */
  | 'no-browser'
  | 'needs-login'
  | 'blocked'

export interface ActionRecipeResult {
  status: ActionRecipeStatus
  sourceId: string
  /** 说清为什么是这个状态 / 下一步该干什么。needs-confirmation 时说"确认后会做什么"；
   *  失败态时说清是哪一类失败。 */
  reason?: string
  /** recipe 自己的一句话描述——needs-confirmation 时带上，让确认对象是"这条 recipe 到底
   *  会干什么"，不只是一个 sourceId。 */
  description?: string
  /** kind:'desktop' 时带上目标应用的进程名（`recipe.app.process`）——用户批准前要知道这个
   *  动作会摆弄哪个窗口。与 `screenTakeover` 成对出现（都只在 kind:'desktop' 时有值）。 */
  targetApp?: string
  /** kind:'desktop' 的动作 recipe 一律带上这句固定提示：桌面 recipe 靠全局 focus + 模拟键盘
   *  输入干活（QQ 这类输入框不认 setValue），执行期间会抢走用户的前台窗口——这是真实的物理
   *  副作用，不是"业务上会发生什么"的延伸。回执之前只讲业务动作（"发一条消息"），没提这件事，
   *  用户没法据此判断"现在方不方便"（比如正在共享屏幕开会）。固定文案而不是从 recipe 自由文本
   *  拼：这是所有 kind:'desktop' 动作 recipe 共有的物理事实，不该指望每条 recipe 的作者都记得写。 */
  screenTakeover?: string
  /** kind:'browser' 的对应物：这个动作会在**用户自己那个 Chrome** 上、带着他真实的登录态动手，
   *  落在哪个 facility 的哪个入口。它是这一档共有的物理事实（不抢屏幕，但确实是"用你的号真的
   *  做了这件事"），所以和 `screenTakeover` 一样由这里固定拼出来，不指望每条 recipe 自己写。 */
  targetSite?: string
  /** 解析后（校验通过）的调用参数——needs-confirmation 时带上，供上层原样转给用户看。 */
  params?: Record<string, unknown>
  /** kind:'desktop' 执行成功后，observer 读回的确认项（如 qq-send 读回刚发出去的那条消息）。 */
  items?: Record<string, string>[]
  /** kind:'desktop' `done` 时被 `branch` 跳过的步骤（`<步骤> ← <分支>`，见 `DesktopRunOutcome.skipped`）。
   *  `wechat-send` 的 `send:false` 靠它说出"正文在输入框里、回车没按"——光看 `done` 和发出去了一模一样。 */
  skipped?: string[]
  /** kind:'desktop' `done` 时**没被判据验过**的理由（`DesktopRunOutcome.unverified`）：`wechat-send-file` 发图片时
   *  微信不画文件名，挂载判据整段跳过——这一趟的 `done` 是"做了"，不是"看见做成了"，调用方要能分开。 */
  unverified?: string[]
  /** 经异步壳跑的那条 run 的 id（`agent-runs.db`，`domain:'action'`）。`running` 时是轮询句柄；
   *  跑完直接回来的结果也带着它，好让"这一次到底是哪条 run"事后可查。同步路径没有这一格。 */
  runId?: string
}

/**
 * `prepareActionRecipe` 的产物：要么是一份**不需要执行**就能回的结果（needs-confirmation /
 * 校验失败 / 环境没就绪），要么是"一切就绪、调 `execute` 就真做"。异步壳（`action-run.ts`）
 * 靠这个分界决定要不要建 run；`key` 是它的在飞幂等键。
 */
export type PreparedAction =
  | { kind: 'result'; result: ActionRecipeResult }
  | { kind: 'ready'; sourceId: string; key: string; execute: () => Promise<ActionRecipeResult> }

export interface ActionRecipeDeps {
  /** 按 sourceId 找一条**原始** recipe（带 `meta.action`/`meta.params_schema`，不是投影过的
   *  `SourceManifest`——那份projection 不带这两格）。找不到返回 undefined。 */
  findRecipe: (sourceId: string) => Recipe | undefined
  /** Stream Desktop 连着吗——没连返回 undefined，判据与 `ReplayAdapter.runDesktop` 一致。 */
  desktopDriver: () => DesktopDriver | undefined
  /** 桌面 recipe 的识别层工厂（`ctx.harvest.makeSee`）——一趟一个实例，绑这条 recipe 的
   *  sourceId。**和采集共用同一个工厂**，缺席 = 宿主没接识别层，用了 `see` 的 recipe 会明说。 */
  makeSee?: (driver: DesktopDriver, sourceId: string) => SeeResolver
  /** 本机学到的落地方式（`ctx.harvest.recipeOverrides`）——**和采集共用同一份存储**，
   *  别在这里另建：各建一份的表现是这条路学到的东西另一条路看不见，而两条路都不报错。 */
  recipeOverrides?: OverrideSource
  /** `format:'path'` 参数的翻译环境（测试用钉死 WSL / wslpath / 文件在不在；省略 = 真探）。 */
  paramEnv?: ParamEnv
  /** 可注入的 desktop recipe 执行器（测试用）；默认真的 `runDesktopRecipe`。 */
  runDesktop?: typeof runDesktopRecipe
  /**
   * 浏览器档的执行器——就是采集在用的那个 `SessionRecipeExecutor.execute`。
   *
   * **有意收成一个函数而不是传整个 executor**：这里要的只有"跑一次"，凭据注入 / 限速 /
   * 冷却 / lane 租约全在它里面，这一层碰都不该碰。没装配它 = 这台后端没接浏览器采集面，
   * 浏览器档一律报 `no-browser`（默认方向是关，同 `writeSecret` 那条）。
   */
  runBrowser?: (
    recipe: CanonicalBrowserRecipe,
    params: Record<string, string>,
  ) => Promise<RecipeRunOutcome>
  /** 用户的 Chrome / 扩展连着吗——判据同 `/api/ext/relay-status`。 */
  browserConnected?: () => boolean
  /**
   * `output.files` 声明的文件产物落到哪个目录（`<dataDir>/action-artifacts`，见 `action-artifacts.ts`）。
   * **没装配而 recipe 声明了文件 → 整条 run 报错**，不退回"把 base64 留在结果里"：那条路的
   * 终点是账本护栏（`RESULT_MAX_BYTES`），同样是错，只是错得更晚、更难读。
   */
  artifactsDir?: string
  /**
   * 这台机器上**能跑的动作 recipe 全名清单**，只用在 `not-found` 那句话里。
   *
   * 为什么值得单开一格：动作 recipe 通常 `discoverable: false`（它不是内容源，不该出现在
   * 两个选择面上），所以原先那句"用 stream_search 确认 id"是**把人支去一个查不到的地方**
   * ——正确的全名在那儿本来就搜不出来。没装配就退回原来那句话，不假装有清单。
   */
  listActions?: () => string[]
  /**
   * 通知中心（`EventsService.emit`）。动作被站方风控挑战 / 撞上登录墙时发一条：这两种结局
   * **都要人来一下**（拖滑块 / 登录），而动作跑在后台批量里，没人盯着回执——不出声就是
   * "任务静默失败等人发现"（2026-09-14 补标题跑到一半弹滑块，是十几分钟后翻日志才知道）。
   * 没装配就不发，回执照旧。
   */
  notify?: (input: EventInput) => void
}

/**
 * 同步入口：准备 + 立刻执行。不接 run 库的宿主（测试、旧装配）走它；生产的 MCP 面走
 * `createActionRunService`（`action-run.ts`），那条路多一层 run 记录与在飞幂等，**判断逻辑是同一份**
 * （都从 `prepareActionRecipe` 来）。
 */
export async function runActionRecipe(deps: ActionRecipeDeps, args: ActionRecipeArgs): Promise<ActionRecipeResult> {
  const prepared = await prepareActionRecipe(deps, args)
  return prepared.kind === 'result' ? prepared.result : prepared.execute()
}

/**
 * 把"跑一条动作 recipe"切成两段：**执行之前的一切判断**（找 recipe、opt-in、参数校验、就绪、
 * 二次确认）在这里同步做完，回 `{kind:'result'}`；全过了回 `{kind:'ready', execute}`，真做的那一下
 * 留给调用方决定什么时候、在什么壳里跑（同步壳 `runActionRecipe` / 异步壳 `action-run.ts`）。
 * 分界线就是"有没有副作用"：`result` 那一档一步都没动过目标应用。
 */
export async function prepareActionRecipe(deps: ActionRecipeDeps, args: ActionRecipeArgs): Promise<PreparedAction> {
  const { sourceId } = args
  const params = args.params ?? {}
  const res = (result: ActionRecipeResult): PreparedAction => ({ kind: 'result', result })

  let recipe: Recipe | undefined
  try {
    recipe = deps.findRecipe(sourceId)
  } catch (e) {
    // 裸名撞上多个包（AmbiguousSourceIdError）。**不许静默挑一个**——挑错了就是去跑了另一个
    // 包的动作，而动作是有副作用的。原样把候选报出去，让调用方改用全名。
    return res({ status: 'not-found', sourceId, reason: e instanceof Error ? e.message : String(e) })
  }
  if (!recipe) {
    const known = deps.listActions?.() ?? []
    return res({
      status: 'not-found',
      sourceId,
      // 动作 recipe 多半 `discoverable: false`，在 stream_search 里本来就搜不到——所以这里
      // 直接把清单给出来，而不是把人支去一个查不到正确答案的地方（见 listActions 头注）。
      reason: known.length
        ? `没有找到 id 为 "${sourceId}" 的动作 recipe。这台机器上能跑的是：${known.join('、')}`
        : `没有找到 id 为 "${sourceId}" 的 recipe，而且这台机器上一条动作 recipe 都没装`,
    })
  }

  if (recipe.meta?.action !== true) {
    return res({
      status: 'not-action',
      sourceId,
      reason:
        `"${sourceId}" 不是一条动作 recipe（meta.action 未声明为 true）——这个工具只跑显式 opt-in ` +
        '的动作 recipe；采集类的内容获取走 stream_read / content_search 等其它工具。',
    })
  }

  const paramsSchema = (recipe.meta.params_schema ?? {}) as Record<string, unknown>

  // 未在 params_schema 里声明的键直接拒掉，不静默透传。桌面执行路线最终把每个值 `String()`
  // 进键盘（见下面 stringParams），一个没声明过的键混进来，值会原样被打进输入框——
  // validateParams 只查"该有的键在不在"，不查"多出来的键该不该在"，这道闸要单独补。
  // hasOwnProperty 而不是 `k in`：`in` 会走原型链，`constructor`/`toString`/`valueOf`/
  // `hasOwnProperty` 这几个键即使 paramsSchema 里没声明也会因为在 Object.prototype 上"命中"，
  // 绕过这道刚加的未声明键闸。
  const unknownKeys = Object.keys(params).filter((k) => !Object.prototype.hasOwnProperty.call(paramsSchema, k))
  if (unknownKeys.length > 0) {
    return res({
      status: 'invalid-params',
      sourceId,
      reason: `params 里有 recipe 的 params_schema 没声明过的键：${unknownKeys.join(', ')}——这类键不会被静默丢弃也不会被静默接受，删掉或改用 schema 里声明过的名字。`,
    })
  }

  // 执行路线判断前置到确认闸之前：这两档都是纯读判断（kind 是不是接了执行路线、Stream Desktop
  // 连没连），没有任何副作用。之前排在确认闸之后，会出现"用户批准了一个注定跑不起来的动作，
  // 第二次调用（带 confirmed:true）才被告知没有 agent"——白费用户一次确认。
  //
  // 字符串化 / 补 default / `format:'path'` 翻译都在 `materializeParams` 里（单步调试与这里同一份）。
  // `default` 服务的是「随机器变的常数」——写死在 recipe 里换台机器就得改 recipe，放进参数带默认值，
  // 换机器只改一次调用；只补缺席的键，不覆盖调用方给的值。
  let stringParams: Record<string, string>
  try {
    validateParams(paramsSchema, params)
    stringParams = materializeParams(paramsSchema, params, deps.paramEnv)
  } catch (e) {
    return res({ status: 'invalid-params', sourceId, reason: e instanceof Error ? e.message : String(e) })
  }

  const description = recipe.meta.description

  if (isCanonicalBrowserRecipe(recipe)) {
    return prepareBrowserAction(deps, recipe, sourceId, params, stringParams, args.confirmed === true, description)
  }

  if (recipe.kind !== 'desktop') {
    return res({
      status: 'unsupported-kind',
      sourceId,
      reason: `kind:"${recipe.kind}" 的动作 recipe 还没接执行路线（今天支持 kind:"desktop" 与 kind:"browser"）`,
    })
  }

  const driver = deps.desktopDriver()
  if (!driver) {
    return res({
      status: 'no-desktop',
      sourceId,
      reason: '桌面 recipe 要靠连到 /api/host 的 Stream Desktop 才跑得动——现在没有连着，先在目标机器上启动 Stream Desktop 再试。',
    })
  }

  // 二次确认闸：不带 confirmed:true 就只回执"会做什么"，一步都不执行。
  if (args.confirmed !== true) {
    return res({
      status: 'needs-confirmation',
      sourceId,
      description,
      params,
      // 只靠 title/windowClass 定位的 recipe 没有 process——回落到它们，不能让 targetApp
      // 在确认回执里静默缺席（用户没法据此判断动的是哪个窗口）。
      targetApp:
        (Array.isArray(recipe.app.process) ? recipe.app.process.join(' / ') : recipe.app.process) ??
        recipe.app.title ??
        recipe.app.windowClass,
      // `input:"message"` 的 recipe 把键鼠投给目标窗口本身，整轮不碰前台——这句话要如实分两档：
      // 照抢屏那句说，用户会为了一条不抢屏的动作等到"不忙的时候"再批。
      screenTakeover: recipe.input === 'message'
        ? '这条动作不抢前台：键鼠输入直接投给目标窗口本身，用户此刻在用的窗口不会被切走，锁屏也照常执行。' +
          '副作用是真的（消息会真的发出去）。'
        : '这条动作会抢走前台窗口，可能退回键盘输入（部分应用的输入框不接受程序化写值）——' +
          '执行期间用户当前正在用的窗口会被切走，共享屏幕/正忙时不建议现在批准。',
      reason: '这是一条有副作用的动作 recipe——把上面的 sourceId/params/description/targetApp/screenTakeover 拿给用户确认，用户同意后带 confirmed:true 重新调用才会真的执行。',
    })
  }

  return {
    kind: 'ready',
    sourceId,
    key: actionRunKey(sourceId, stringParams),
    execute: () => executeDesktopAction(deps, recipe, sourceId, stringParams, driver),
  }
}

/** 桌面档真做的那一下。只在 `prepareActionRecipe` 全过之后被调，前置判断一律不在这里重做。 */
async function executeDesktopAction(
  deps: ActionRecipeDeps,
  recipe: DesktopRecipe,
  sourceId: string,
  stringParams: Record<string, string>,
  driver: DesktopDriver,
): Promise<ActionRecipeResult> {
  try {
    // I1：交互路径用比默认 sessionWaitMs（180s）短得多的等待上界——MCP 客户端自己的调用
    // 超时通常远小于 180s，排太久不给就先失败，比"客户端已经超时放弃、排队里那份动作却在
    // 之后悄悄真的执行"更安全（同一个副作用被做两遍）。见 INTERACTIVE_SESSION_WAIT_MS 头注。
    // `see` 是工厂不是实例：runner 自己在开跑那一刻建一个，`modelCalls` 的预算才归这一趟。
    const makeSee = deps.makeSee
    const outcome = await (deps.runDesktop ?? runDesktopRecipe)(recipe, stringParams, driver, {
      waitMs: INTERACTIVE_SESSION_WAIT_MS,
      ...(makeSee && { see: (d: DesktopDriver) => makeSee(d, recipe.sourceId) }),
      // 本机学到的落地方式，原样递。**不递 `packageInfo`**：这一跳手里只有 `Recipe`，
      // 没有包身份；override 文件的 `package` 字段由贡献时的 CLI 补，运行时不填。
      ...(deps.recipeOverrides && { overrides: deps.recipeOverrides }),
    })
    if (outcome.outcome === 'needsLogin') {
      return { status: 'needs-login', sourceId, reason: `"${sourceId}" 需要重新登录` }
    }
    if (outcome.outcome === 'drift') {
      return { status: 'blocked', sourceId, reason: outcome.driftReason ?? '动作没能确认执行成功（drift）' }
    }
    return {
      status: 'done',
      sourceId,
      items: outcome.items,
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      ...(outcome.unverified ? { unverified: outcome.unverified } : {}),
    }
  } catch (e) {
    // agent 中途掉线/超时：和 ReplayAdapter.runDesktop 同一个判据——报成 no-desktop 而不是
    // 让原始异常炸出去,因为对调用方来说这就是"agent 没连稳",不是这条 recipe 本身坏了。
    // 用户在本机按了中止热键。**必须排在断连那一档前面**，也必须报成 blocked 而不是
    // no-desktop：agent 是健康的，坏的是"这趟被人叫停了"。报错成 agent 问题会把用户
    // 引去查 agent，而正确的下一步是看目标应用的实际状态。
    if (e instanceof HostAbortedByUser) {
      return { status: 'blocked', sourceId, reason: USER_ABORTED_REASON }
    }
    if (e instanceof HostRelayDisconnected || e instanceof HostRelayTimeout) {
      return {
        status: 'no-desktop',
        sourceId,
        reason: 'Stream Desktop 在执行中途断开——动作可能已部分执行，先检查目标应用的实际状态，再决定要不要重试。',
      }
    }
    // 排队等桌面会话租约超时（另一条 recipe/单发操作占着没让出来）——和上面那档分开报：
    // agent 本身是健康的，这条动作大概率**还没开始执行**（卡在排队），单纯重试即可，不用去查
    // agent 状态。
    if (e instanceof HostSessionQueueTimeout) {
      return {
        status: 'no-desktop',
        sourceId,
        reason: SESSION_BUSY_REASON,
      }
    }
    throw e
  }
}

/**
 * `kind:'browser'` 的那一档。和桌面档并列，不是它的特例——两者的就绪判据、物理副作用、
 * 失败分类全都不一样，硬合成一条只会让两边的 reason 都变含糊。
 *
 * 执行一律走 `deps.runBrowser`（= `SessionRecipeExecutor.execute`），理由见文件头注：
 * 凭据注入、限速、冷却、lane 租约都在它里面，绕过去的那些闸没有一处会喊。
 */
async function prepareBrowserAction(
  deps: ActionRecipeDeps,
  recipe: CanonicalBrowserRecipe,
  sourceId: string,
  params: Record<string, unknown>,
  stringParams: Record<string, string>,
  confirmed: boolean,
  description: string | undefined,
): Promise<PreparedAction> {
  const res = (result: ActionRecipeResult): PreparedAction => ({ kind: 'result', result })
  // **回执一律回调用方给的那个 id，不是 `recipe.sourceId`。** 两者不是一回事：装载期给内置包
  // 的 recipe 加了命名空间前缀（`@streamapp/dfcf/dfcf-login`），而 recipe 体里写的是局部名
  // （`dfcf-login`）。回局部名的后果很具体——工具要求用户"带 confirmed:true 用同一个 sourceId
  // 再调一次"，照回执抄那个 id 会得到 not-found，而第一次调用明明成功了。桌面档一直用的就是
  // 调用方那个 id，这里跟它对齐。

  // 就绪判断同样前置到确认闸之前（理由同桌面档：别让用户批准一个注定跑不起来的动作）。
  const runBrowser = deps.runBrowser
  if (!runBrowser) {
    return res({
      status: 'no-browser',
      sourceId,
      reason: '这台后端没有接浏览器采集面，跑不了 kind:"browser" 的动作 recipe。',
    })
  }
  if (deps.browserConnected?.() === false) {
    return res({
      status: 'no-browser',
      sourceId,
      reason: '浏览器 recipe 要在你自己的 Chrome 里跑——现在扩展没连着，先打开 Chrome、确认 Stream 扩展已连上再试。',
    })
  }

  // 落在哪个站、用谁的号——浏览器档的物理事实，确认之前必须说出来。**不含任何凭据**：
  // 这条 recipe 的账号密码走 secret_params 由宿主注入，压根不在 params 里（那正是它的
  // 存在理由——二次确认回执会把 params 原样给用户看）。
  const targetSite =
    `会在你自己的 Chrome 里新开一个标签，用你当前的登录态在 ${recipe.session.facility}` +
    `（${recipe.entryUrl}）上真的执行这个动作——不抢前台窗口，但副作用是真的。`

  if (!confirmed) {
    return res({
      status: 'needs-confirmation',
      sourceId,
      description,
      params,
      targetSite,
      reason: '这是一条有副作用的动作 recipe——把上面的 sourceId/params/description/targetSite 拿给用户确认，用户同意后带 confirmed:true 重新调用才会真的执行。',
    })
  }

  return {
    kind: 'ready',
    sourceId,
    key: actionRunKey(sourceId, stringParams),
    execute: () => executeBrowserAction(runBrowser, recipe, sourceId, stringParams, deps.notify, deps.artifactsDir),
  }
}

/** 浏览器档真做的那一下（`prepareBrowserAction` 全过之后）。 */
async function executeBrowserAction(
  runBrowser: NonNullable<ActionRecipeDeps['runBrowser']>,
  recipe: CanonicalBrowserRecipe,
  sourceId: string,
  stringParams: Record<string, string>,
  notify?: (input: EventInput) => void,
  artifactsDir?: string,
): Promise<ActionRecipeResult> {
  const outcome = await runBrowser(recipe, stringParams)
  const files = recipe.output.files
  if (outcome.outcome === 'ok' && files && Object.keys(files).length > 0) {
    if (!artifactsDir) {
      throw new Error(`[action] "${sourceId}" 声明了 output.files，但这台后端没装配产物目录（artifactsDir）——文件没处落`)
    }
    // 在 String() 之前落盘：这里的值就是页内交出来的 base64，换成路径之后再进回执 / 账本。
    spillArtifacts(artifactsDir, files, outcome.items as Record<string, unknown>[])
  }
  if (notify && (outcome.outcome === 'challenged' || outcome.outcome === 'needsLogin')) {
    const facility = recipe.session.facility
    const label = recipe.meta?.title ?? sourceId
    const challenged = outcome.outcome === 'challenged'
    notify({
      type: challenged ? 'action.challenged' : 'auth.needed',
      severity: 'warn',
      title: challenged ? `${facility} 弹了风控验证，「${label}」停下了` : `${facility} 要重新登录，「${label}」停下了`,
      body: challenged
        ? `去 Chrome 里打开 ${recipe.entryUrl} 把验证拖一下；这段时间 ${facility} 的动作都在冷却，过了会自己接着跑。`
        : `在 Chrome 里登录 ${facility}（${recipe.entryUrl}），登好之后重跑这个动作。`,
      // 同一站点连着几条动作都撞上，只留一条未读。
      dedupeKey: `${challenged ? 'action.challenged' : 'auth.needed'}:${facility}`,
    })
  }
  switch (outcome.outcome) {
    case 'ok':
      // observer 读回的确认项。**逐值 String()**：MappedItem 的值是 unknown（映射规则可以
      // 产出数字/布尔/null），而回执面对的是人和模型，形状要和桌面档那份一致。
      return {
        status: 'done',
        sourceId,
        items: outcome.items.map((it) =>
          Object.fromEntries(Object.entries(it).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])),
        ),
      }
    case 'needsLogin':
      // 对一条**登录** recipe 来说这一档的意思是"登完还在登录页"，也就是登录失败本身
      // （密码错 / 验证码认错 / 安全控件没 hook 上）。照实报，别翻译成"去登录"。
      return { status: 'needs-login', sourceId, reason: outcome.reason ?? `"${sourceId}" 跑完仍停在登录墙上` }
    case 'unavailable':
      // 环境没就绪（浏览器断了），**recipe 一步都没跑**。绝不能并进 blocked——那是"站点拦了
      // 我们"，两者的下一步完全相反（见 RecipeRunOutcome 头注）。
      return { status: 'no-browser', sourceId, reason: outcome.reason ?? '浏览器不可用，这次一步都没跑' }
    case 'challenged':
      return { status: 'blocked', sourceId, reason: outcome.reason ?? '站方风控挑战——登录态没坏，等冷却过去再试' }
    case 'cancelled':
      return { status: 'blocked', sourceId, reason: outcome.reason ?? '这次运行被取消了' }
    default:
      // blocked / drift：动作没能确认执行成功。带上 recipe 自己的 reason，别吞掉。
      return { status: 'blocked', sourceId, reason: outcome.reason ?? '动作没能确认执行成功' }
  }
}
