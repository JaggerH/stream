import { substitute } from './interpret.ts'
import type { DesktopDriver, A11yElement, A11yQuery, AppMatch, InputDelivery, Rect } from './desktop-driver.ts'
import { concretizeApp, isParamCondition, processMatches } from './desktop-recipe.ts'
import type { DesktopMap, DesktopQuery, DesktopRecipe, DesktopStep, DesktopStepExpect, DesktopWindowMatch, See } from './desktop-recipe.ts'
import { sameSpot, type SeeHit, type SeeMode, type SeeResolver, type SeeVia } from './desktop-see.ts'
import { classifyDesktopError } from './desktop-failure.ts'
import { rankGroundings, effectiveStep, resolveArea, type GroundingFacts, type Grounding, type RankedGrounding, type ResolvedArea } from './desktop-grounding.ts'
import type { UsedGrounding } from './desktop-override-store.ts'
import { LoggingRepairRunner, type RepairRunner } from './repair-runner.ts'
import { captureDesktopScene, type Scene } from './scene.ts'

/**
 * The desktop recipe runner — parallel to the browser `runBrowserRecipe`, but it drives a
 * `DesktopDriver` (a11y vocabulary) instead of the browser `PageDriver`, so it never touches
 * DOM selectors. It executes the recipe's pre-read steps (focus / native invoke / type /
 * scroll), then reads the result subtree into items with dedupe + optional scroll paging.
 * Deterministic, zero-token — the model does not run at replay.
 */
/** 单步调试的闸（`runDesktopRecipe` 的 `opts.stepGate`）：每一步开始之前问一次。 */
export type StepGate = (info: { index: number; step: DesktopStep; total: number }) => Promise<'run' | 'abort'>

/** 本机 override 的读写口（`RecipeOverrideStore` 的子集）。runner 只读它、只在整趟 done 后写它。 */
export interface OverrideSource {
  groundingsFor(sourceId: string, label: string): Grounding[]
  recordRun(sourceId: string, used: UsedGrounding[], facts: GroundingFacts, pkg?: { name: string; version: string }): void
  /**
   * 和包里那份对一次账：本机某条已经被上游收编（同 key 同 body → 删）或被包里新的一条覆盖
   * （同 key 不同 body → 标 shadowed，不再参与）。
   *
   * **在这里（每趟运行开头）而不是装配期**：包的装/卸是 sources 域**进程内**热重载的，不重启
   * 后端——装配期对一次账就漏掉了"包升级"这条主路径，而漏掉的表现是本机那份永远压着包里的
   * 新版本，两边都不报错。每趟跑之前对一次，热更来的新包下一趟就吃得到。
   *
   * 可选：实现方没有这格（测试里的假存储）就不对账，不伪造一个"对过了"。
   */
  reconcile?(
    sourceId: string,
    recipe: { steps: Array<{ label?: string; groundings?: Grounding[] }>; areas?: Record<string, { groundings?: Grounding[] }> },
  ): { removed: number; shadowed: number }
  /** 一块具名区域的本机落地方式（`See.area` 查的那张表）。可选：没这一格就只有包里那份参与。 */
  areaGroundingsFor?(sourceId: string, name: string): Grounding[]
}

export interface DesktopRunOutcome {
  /**
   * `challenged` = 站方的风控挑战。和 `needsLogin` **严格分开**：登录态好好的、用户什么都
   * 不用做、等冷却即可；判成 `needsLogin` 会把人支去白登录一次，判成 `drift` 会去修一份
   * **根本没坏**的 recipe——而且它会连着几次把这个源隔离，此后返回 `items:0 + errors:[]`，
   * 和「跑成功了、但确实没读到」一模一样，于是真正坏了的那天你已经分不出来了。
   *
   * 故意和 `recipe-runner.ts` 用同一个词、同一套语义，好共用下游（facility 冷却）。
   *
   * **今天没有任何一处产出它**：出口先备好，接线是下一期的事（把状态图接到桌面这一侧）。
   * 缺这一档的话，那时撞上挑战只能判 `drift`，正好踩中上面那条。
   */
  outcome: 'ok' | 'needsLogin' | 'challenged' | 'drift'
  items: Record<string, string>[]
  driftReason: string | null
  /**
   * 这一轮的文字是怎么打进去的——**只在 recipe 真有 `type` 步骤时才有值**。
   *
   * `'value'` = 写进元素，整轮没抢屏；`'keyboard'` = 退回了 Engine 键盘，**这一轮抢了用户的屏**。
   * 退路必须留痕：一个静默的 fallback 会让"半夜抢屏"换个地方原样长回来，而现象（屏幕突然
   * 跳到 Telegram）和原因（这个控件不认 Value pattern）隔着十万八千里，没有这个字段就查不动。
   */
  typedVia?: 'value' | 'keyboard'
  /**
   * 每个用了 `see` 的步骤实际走的路（键 = `label`，没写 label 就 `#<序号>`）。
   *
   * **活体上"靶子是靠模型还是靠缓存找到的"必须可读出来**——否则第一次成功（模型指的那次）
   * 和第 N 次成功（模板缓存命中）看起来一模一样，分不出这条 recipe 是稳了、还是每轮都在
   * 烧 token。与 `typedVia` 同一个词、同一个理由。
   */
  seeVia?: Record<string, SeeVia>
  /**
   * 这一趟消化掉的打断（每项是 `JSON.stringify(interrupt.see)`），没消化过就**没有这个字段**。
   *
   * 弹窗是这条链路上最典型的"成功了但不对劲"：广告框被关掉、recipe 照常跑完、结果一切正常，
   * 于是没有人知道每一轮都要先关一次广告。留下这行字才有人去把它变成一条更好的 recipe。
   */
  dismissed?: string[]
  /**
   * 每步用了哪条落地方式：`package:<platform>` / `local:<platform>` / `universal`——退路要留痕。
   *
   * 同 `typedVia` / `seeVia` 的理由：一条步骤有好几份并列的 body，走通的是哪一条**在回执上看不见**
   * 的话，"包里那条还管用"和"每趟都靠本机 override 兜着"长得一模一样，而后者正是该被贡献回上游的信号。
   */
  groundings?: Record<string, string>
  /**
   * 每块具名区域这一趟落到了哪份（区域名 → tag，同 `groundings` 那格的词汇）。
   *
   * 同一个理由：两个平台各写一块、判据照样"成立"时，选中的是哪一条在回执上看不见——而选错
   * 一块的表现是判据在一片没有东西的屏上恒假，读起来像界面变了。
   */
  areas?: Record<string, string>
  /**
   * 这一趟被 `branch` 跳过的步骤，每项 `<步骤 label 或 #序号> ← <那条 branch 的 label 或 #序号>`；
   * 一步都没跳过就**没有这个字段**。
   *
   * 它是「做了什么、没做什么」的回执：`wechat-send` 的 `send:false` 一趟 `ok` 收场，光看 `outcome`
   * 和"发出去了"一模一样——`skipped: ["回车发出去 ← 不发就停在这"]` 才说出"正文在输入框里、没按回车"。
   * 读屏的分支同样记（走了哪条入口路一眼可见）。
   */
  skipped?: string[]
  /**
   * 这一趟的结果**没被判据验过**的理由（每项来自一条成立的 `branch.unverified`）；一条都没有就
   * **没有这个字段**。`ok` + `unverified` = "做了、但没人看见它做成"——和一趟验过的 `ok` 必须分得开。
   */
  unverified?: string[]
  /**
   * 每个 `pickFile` 步骤的回执（键 = `label`，没写就 `#<序号>`）。失败的一趟也带着走到哪一段为止的
   * 计时——"对话框 5 秒才弹"和"文件名框找了 5 秒"在 driftReason 上只差一个前缀，耗时才分得出慢在哪。
   */
  pickFile?: Record<string, PickFileReceipt>
}

export interface PickFileReceipt {
  /** 走通的确认方式；没走到确认那一段就**没有这个字段**。 */
  via?: 'value+enter' | 'keyboard+enter' | 'button' | 'goto+enter'
  /** 认出来的那个对话框（真实标题）。 */
  dialog?: { process: string; title: string }
  /** 各段耗时（ms）：等对话框出现 / 找框 + 写路径 / 确认到消失。没走到的段缺席。 */
  ms: { appear?: number; fill?: number; close?: number; total: number }
  /** 对话框消失后主窗（`recipe.app`）是不是回到了前台——图片这类没有文字判据的挂载只剩这一个弱信号。 */
  foregroundBack?: boolean
}

/** 「这条 recipe 用了 `see`，但宿主没配识别层」——由 `locate` 抛，被步骤循环翻成 drift。
 *  和"找不到目标"分开：那是界面变了，这是我们自己没接线，下一步完全不同。 */
class SeeUnavailable extends Error {}

/** 一次 `locate` 没找到时，报错要用的那几样：填过参的 see、这一次模型段有没有被预算关掉、
 *  模型那一段到底跑没跑（`expect` 那条路一开始就不许调模型，跟"预算用满了"是两回事）。 */
/** `modelRan` = 模型这次**真的**被调了（看计数）；`modelSkipped` = 允许调却没调（没配模型 / 没有
 *  候选框 / 两次抓拍尺寸不一致）。两者分开是为了那句「没找到」不说假话。 */
interface SeeMiss { filled: See; capped: boolean; modelRan: boolean; modelSkipped: boolean }

/** Fill `{param}` holes in a query's textual fields (name / className)。
 *  泛型是为了让 `nameAnyOf` 原样跟着走——签名写成 `A11yQuery` 时它在类型上"消失"，
 *  运行时却还在（spread 带过去了），下一个改这里的人会以为它已经被处理掉了。 */
function subQuery<T extends DesktopQuery>(q: T, params: Record<string, string>): T {
  const out: T = { ...q }
  if (q.name !== undefined) out.name = substitute(q.name, params)
  // nameContains 同样要填参：「按名打开某个频道」这类 recipe 的整条路都建立在它上面
  // （会话列表项的 name 是一整句动态文本，只有频道名那一截稳定）。漏掉它，参数会原样留成
  // 字面的 `{channel}` 去匹配——结果是空，看起来像"这个频道不存在"。
  if (q.nameContains !== undefined) out.nameContains = substitute(q.nameContains, params)
  if (q.className !== undefined) out.className = substitute(q.className, params)
  return out
}

/**
 * 应用 recipe 的 `map`：从已读字段里再抽一层结构化字段（见 `DesktopMap`）。
 *
 * 抽不到就**不设**这个键（不是空串）——空串会让下游把"没抽到"当成"抽到了一个空标题"，
 * 而 `(untitled)` 至少还看得出是缺失。正则不合法在 recipe 装载时就被拒了（`recipe-store`），
 * 所以这里只管抽。
 */
export function applyMap(item: Record<string, string>, map: DesktopMap | undefined): Record<string, string> {
  if (!map) return item
  const out = { ...item }
  for (const [field, rule] of Object.entries(map)) {
    const src = item[rule.from]
    if (src == null) continue
    const m = src.match(new RegExp(rule.match))
    if (!m) continue
    const v = (m[1] ?? m[0]).trim()
    if (v) out[field] = v
  }
  return out
}

/**
 * 打字的两条路，以及它们之间的退路。
 *
 * 给了 `query` 就先试**写进元素**（`setValue`，不需要前台）；它可能不成——不是所有控件都认
 * Value pattern，自绘应用的 provider 尤其常见。不成就退回 Engine 键盘，而键盘投给焦点窗口，
 * 所以那条路必须先抢屏。
 *
 * **定位不到输入框也走退路，不判 drift**：键盘那条路本来就不需要这个元素（焦点是上一步的
 * 点击给的），把它升级成 drift 等于让一个可选的加速手段变成新的失败点。
 *
 * 返回走了哪条路——调用方要把它报出去（见 `DesktopRunOutcome.typedVia`）。
 */
async function typeInto(
  driver: DesktopDriver,
  step: { text: string; query?: DesktopQuery; requireTarget?: boolean },
  params: Record<string, string>,
  foreground: () => Promise<unknown>,
  /** 走调用方那个收旗的 find（不是 `driver.find`）——直接调 driver 会把这次的 `unbuilt` 丢掉。 */
  find: (q: DesktopQuery) => Promise<A11yElement[]>,
  deliver?: InputDelivery,
): Promise<'value' | 'keyboard' | 'no-target'> {
  const text = substitute(step.text, params)
  if (step.query) {
    const el = (await find(subQuery(step.query, params)))[0]
    // requireTarget = 这一步必须打进**那个**框（见 `DesktopStep` 的 type 分支）。退回键盘会把
    // 文字打给此刻碰巧有焦点的东西，而这一步照样"成功"——由调用方判 drift。
    if (!el && step.requireTarget) return 'no-target'
    if (el) {
      try {
        await driver.setValue(el.ref, text)
        return 'value'
      } catch (e) {
        // 这个控件不认——退回键盘。**原因不吞**：现象（屏幕突然跳到目标应用）和成因（provider
        // 不给 Value pattern）隔得太远，不打出来就只剩一个查不动的"它又抢屏了"。
        console.warn(`[desktop] setValue 不成，退回键盘（这一轮会抢屏）：${(e as Error).message}`)
      }
    } else {
      console.warn(`[desktop] 没定位到输入框 ${JSON.stringify(subQuery(step.query, params))}，退回键盘（这一轮会抢屏）`)
    }
  }
  await foreground()
  await driver.type(text, undefined, deliver)
  return 'keyboard'
}

/** 「抬不到前台」——由 `foreground()` 抛，被步骤循环翻成那一步的 drift（见 `foreground`）。 */
class ForegroundRefused extends Error {}

/**
 * 识别层那一侧的**硬失败**前缀（`readText` / `readElements` / `findImage` 在 Stream Desktop
 * 里抛的那几种）。
 *
 * 它们不是"界面变了"，而是"这台机器上读不了屏"——没确立目标窗口、PrintWindow 截不出来、
 * region 和窗口画面没有交集、exe 旁缺了读屏模型三件或 ONNX Runtime 动态库（`ocr-missing:` /
 * `ort-missing:`，两平台同一判据、不回落，`app/host-agent/src/ocr.rs`）。裸抛上去的话，
 * 整趟采集会以一个未捕获异常收场：`driftReason` 是 null，而那句唯一说得清怎么办的话
 * （"…要和 ocr-det.onnx 放在同一目录（或 STREAM_ORT_LIB 指到它）"）连一次都没被人看见。
 * 翻成 drift 之后它落进 `driftReason`，复盘工具和 debug bus 才够得着它。
 *
 * **这份名单是按前缀字面匹配的，所以 op 或错误措辞一改它就静默失效**：`readScreen:` 拆成
 * `readText` / `readElements` 两个 op 之后，那条前缀永远匹配不上，硬失败会退化成"当作没找到、
 * 轮询到超时"——每一步都白等三秒，而唯一有用的那句话仍然没人看见。同一个病此前已经躺过一次：
 * `no-window:` 从来就不是 agent 发出的前缀（它发的是 `no-window-match:`），那一条从写下那天
 * 起就匹配不上任何东西。所以 `desktop-runner.test.ts` 里有一条**拿 host agent 的源码对账**
 * 的守卫：名单里的每个前缀都必须在 `app/host-agent/src/` 里真的出现过。
 */
export const HARD_SEE_ERRORS = ['no-scope:', 'no-capture:', 'no-window-match:', 'ocr-missing:', 'ort-missing:', 'bad-region:', 'bad-template:']

/**
 * 要不要往接管指示条上写"现在在做第几步"（`DesktopDriver.status`）。默认开；
 * `STREAM_DESKTOP_STATUS=0` 关。和 `STREAM_DESKTOP_SEE_TRACE` 一样直接读环境变量——
 * 一个布尔不值得一套配置体系。关掉时 runner 一条 status 都不发（连结尾的清除也不发）。
 */
export function desktopStatusEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STREAM_DESKTOP_STATUS !== '0'
}

/**
 * 条子上那两行的形状（overlay 按 `\n` 拆成第一、二行；热键说明画在第一行末尾，"AI 正在操作你的电脑"由屏幕四边的七彩描边表达）：
 *
 *     <meta.title ?? recipe id>[ · <meta.purpose 填参>]
 *     <步骤 label 或 kind> (<第几步>/<共几步>)
 *
 * **参数只经 `meta.purpose` 上屏**：那是作者写的模板、只吃作者点名的那个参数（装载期已钉住占位
 * 都在 `params_schema` 里，见 `recipe-store.ts`）。步骤 label 里的 `{contact}` 模板照旧原样留着不
 * 替换——这句话是要上屏的，联系人、正文这类东西不该出现在谁路过都看得见的地方。
 */
export function stepStatusText(
  recipe: { sourceId: string; steps: { length: number }; meta?: { title?: string; purpose?: string } },
  params: Record<string, string>,
  i: number,
  step: { kind: string; label?: string },
): string {
  const title = recipe.meta?.title ?? recipe.sourceId
  const purpose = recipe.meta?.purpose
  // purpose 填参后可能带换行（参数值本身含 \n）；第二行靠首个 \n 拆分，换行会把它挤掉，压平成空格。
  const head = purpose ? `${title} · ${substitute(purpose, params).replace(/\s*\n\s*/g, ' ')}` : title
  return `${head}\n${step.label ?? step.kind} (${i + 1}/${recipe.steps.length})`
}

/** `window` 步骤的轮询间隔。窗口是"出现/不出现"的离散事件，没有更细的信号可等。
 *  一轮的钱是一次 `windows()`（Windows 上 30–40ms，2026-09-29 量的），所以间隔可以很密：
 *  平均白等的是半个间隔，500ms 那档每个 `window` 步骤平均多等 250ms。 */
const WINDOW_POLL_MS = 150

/** `expect` 动作后的轮询间隔。界面对一次点击 / 按键的反应通常在一两百毫秒内，而一轮带
 *  region 的读屏只要 40–80ms（2026-09-29 量的）——间隔越粗，每个带判据的步骤平均白等越多
 *  （半个间隔）。整窗读屏要一两秒的判据自己就慢，间隔再密也只是多读几次，由墙钟超时兜住。 */
const EXPECT_POLL_MS = 150
/** `focus.wake` 之后等渲染端回来的上界与轮询间隔（判据是控件树非空，见那一步的注释）。 */
const WAKE_TIMEOUT_MS = 6000
const WAKE_POLL_MS = 300
/** `press.times` 连按之间的间隔。连按太快会被应用合并/丢弃（活体：一串 Tab 挤在一起只走了一格）。 */
const PRESS_GAP_MS = 250
/** `pickFile`：等对话框出现 / 确认后等它消失的默认上界。出现要几秒（Windows 枚举 shell 目录）；消失通常一秒内。 */
const PICK_FILE_APPEAR_MS = 12_000
const PICK_FILE_CLOSE_MS = 8_000
/** `pickFile` 默认怎么认对话框（`dialog` 省略时，按 agent 报的平台）。标题是包含匹配。 */
const PICK_FILE_DIALOG_TITLES: Record<'win32' | 'darwin', string[]> = {
  // comdlg 默认「打开」；应用可以改标题（微信 4.1.13 改成「选择文件」，活体 2026-09-18）；英文界面 Open。
  win32: ['打开', '选择文件', 'Open'],
  // NSOpenPanel：mac agent 给无标题的 AXSheet / AXDialog 合成标题（surface-desktop.md）。待活体验证。
  darwin: ['<无标题 AXSheet>', '<无标题 AXDialog>', '打开', 'Open'],
}
/** Windows 文件对话框底部那个文件名框（comdlg32 字符串表，跟显示语言走；冒号是名字的一部分）。 */
const PICK_FILE_EDIT_WIN: DesktopQuery = { role: 'Edit', nameAnyOf: ['文件名(N):', '文件名:', 'File name:'] }
/** 右下角的确认键——**只当备选**：它不一定在树里（同一台机器两次抓取一有一无，2026-09-18）。
 *  候选里不能放裸的「打开」：同一对话框里还有两个 32px 的 `Button`「打开」小箭头。 */
const PICK_FILE_CONFIRM_WIN: DesktopQuery = { role: 'Button', nameAnyOf: ['打开(O)', 'Open'] }
/** macOS：面板上敲 `/` 弹出的「前往文件夹」输入框与面板的确认键（按 AXIdentifier 认，不吃界面语言；
 *  同 `chrome-ext-page.ts` 的 `GOTO_FOLDER_PATH_MAC` / `FOLDER_PANEL_CONFIRM_MAC`）。待活体验证。 */
const PICK_FILE_GOTO_MAC: DesktopQuery = { role: 'AXTextField', className: 'PathTextField' }
const PICK_FILE_CONFIRM_MAC: DesktopQuery = { role: 'AXButton', className: 'OKButton' }

/**
 * 等一个顶层窗口出现。`AppMatch` 的 `title` 是**包含**匹配（见 `AppMatch.title`），所以这里
 * 也照包含匹配来——真实标题带动态前后缀，全等在活体上几乎必然落空。
 */
async function waitForWindow(driver: DesktopDriver, match: DesktopWindowMatch, timeoutMs: number, now: () => number) {
  const titles = match.titleAnyOf ?? (match.title == null ? [] : [match.title])
  // 超时按墙钟判（同 `awaitExpect`）：按 `timeoutMs / 间隔` 数轮数等于把每轮 `windows()` 的
  // 开销当成 0。至少看一眼；睡完就过点的那一觉不睡。
  const deadline = now() + timeoutMs
  for (;;) {
    const hit = (await driver.windows()).find(
      (w) =>
        processMatches(match.process, w.process) &&
        (titles.length === 0 || titles.some((t) => w.title.includes(t))),
    )
    if (hit) return hit
    if (now() + WINDOW_POLL_MS >= deadline) return undefined
    await driver.sleep(WINDOW_POLL_MS)
  }
}

/**
 * 入口：把一整趟 recipe 包进 driver 的会话租约（若背后的 relay 支持——见
 * `DesktopDriver.withSession` / `WsHostRelay.withSession` 头注）。这是唯一的咽喉——
 * `src/adapters/replay/adapter.ts` 和 `src/mcp/action-recipe.ts` 两个调用方都经这里，
 * 租约放在这一层，以后加第三个调用方也不会漏接。没有租约（测试假 driver 常见）就直接跑，
 * 不做跨调用互斥。
 *
 * `opts.waitMs`：排队等会话租约的等待上界透传给 `withSession`——调度采集（`adapter.ts`）
 * 不传，吃默认的宽松档；`action-recipe.ts` 那条交互路径传 `INTERACTIVE_SESSION_WAIT_MS`
 * （见其头注 I1：交互路径要在调用方自己的客户端超时之前先失败，不然超时后排队里那份
 * op 还会真的执行，造成"同一个动作做了两遍"）。
 */
export async function runDesktopRecipe(
  recipe: DesktopRecipe,
  params: Record<string, string>,
  driver: DesktopDriver,
  opts?: {
    waitMs?: number
    see?: (driver: DesktopDriver) => SeeResolver
    /** 读时钟的那一下（默认 `Date.now`）。`expect` 的超时是**墙钟**，而测试里的假 driver 一觉
     *  是零耗时的——不让测试驱动这只表，"等了多久"就没法在单测里钉住。 */
    now?: () => number
    /** 介入闸的收件人（`expect` 未兑现且靶子来自缓存时，交出一条 locator 提议）。
     *  不传 = 只打日志。**它绝不会改 recipe**，见 `RepairProposal`。 */
    repairRunner?: RepairRunner
    /** 这条 recipe 的设施键，随介入闸的提议一起交出去（`RepairProposal.facility`）。
     *  `DesktopRecipe` 本身不携带 facility——它是浏览器侧 `session.facility` 的对应概念，
     *  desktop 这边只在 `SourceManifest.facility`（调用方持有）上才有；这里只负责透传，
     *  不传就是老路径，Broker 退回用 `sourceId`（见 `RepairProposal.facility` 头注）。 */
    facility?: string
    /**
     * **单步调试的闸**：每一步（含 `branch`）开始之前先问它，回 `'run'` 才动，回 `'abort'` 整轮
     * 以 drift 收场（`aborted-by-debugger@…`）。给"人和 agent 一起看着 recipe 一步一步走"用：
     * 闸挂在 runner 里而不是另写一个单步 runner——**两条路必须是同一条路**，否则单步下能过、
     * 整跑就挂的差异永远查不出来。不传 = 老路径，一步都不停。
     */
    stepGate?: StepGate
    /** 探针那几行（`[desktop-probe]`）也交给它一份——单步调试要把"这一步走了哪条识别路、
     *  判据成没成立"原样回给看的人，而这些话本来就在探针里。 */
    onProbe?: (msg: string) => void
    /** 本机学到的落地方式（`RecipeOverrideStore`）。不传 = 只认包里那几条 + 顶层通用 body。 */
    overrides?: OverrideSource
    /** 这份 recipe 来自哪个包——只随记账一起交出去（贡献链要知道对的是哪个版本）。 */
    packageInfo?: { name: string; version: string }
  },
): Promise<DesktopRunOutcome> {
  // 指示条上的任务文字要在**租约内**清掉：清在租约外，下一趟已经写上自己的第一步了，
  // 这一下会把人家的擦掉。成功 / 失败 / abort 都走这个 finally——没清掉的"第 8 步"会一直挂着。
  const run = async () => {
    try {
      return await runDesktopRecipeLocked(recipe, params, driver, opts?.see, opts?.now, opts?.repairRunner, opts?.facility, {
        ...(opts?.stepGate ? { stepGate: opts.stepGate } : {}),
        ...(opts?.onProbe ? { onProbe: opts.onProbe } : {}),
        ...(opts?.overrides ? { overrides: opts.overrides } : {}),
        ...(opts?.packageInfo ? { packageInfo: opts.packageInfo } : {}),
      })
    } finally {
      // 清不掉（WS 已断、abort 后中继拒收）不许盖过正在抛的那个原因——finally 里再抛，
      // 人看到的就是"status 失败"而不是真正让这趟停下来的那句话。
      if (desktopStatusEnabled()) await driver.status(null).catch(() => {})
    }
  }
  const out = driver.withSession ? await driver.withSession(run, opts) : await run()
  return annotateInputSurface(recipe, driver, out)
}

/** 锁屏时占着前台的那两个：Windows 的锁屏界面与登录界面。 */
const LOCK_SCREEN_PROCESSES = ['lockapp.exe', 'logonui.exe']

/**
 * 失败的时候顺带说一句**这一轮是在什么屏幕状态下跑的**。只在 `input:'message'` 且判了 drift 时
 * 问一次 `windows()`，正常那条路一次都不多花。
 *
 * 为什么必须有这一句：`deliver:'message'` 这条路把键鼠 `PostMessage` 给窗口，而 `PostMessage`
 * **投出去必然成功**——收件人收下之后理不理它，这边一个字都读不到。屏幕锁着的时候，Chromium
 * 一类应用会把自己判成 occluded、把渲染端挂起，于是投进去的点击和按键被整轮静默丢弃：
 * 每一步都在"expect 未兑现"上失败，而失败在哪一步纯看运气。本机 2026-09-07 实测：锁屏时
 * 往 QQ 投点击 + 打字 **0/12** 一次反应都没有（同一时刻窗口 `visible=1 iconic=0`、坐标核对无误、
 * 线程输入队列还报着 `focus=<自己>`）——**没有任何一处会喊**，读的人只看到一条随机步骤的 drift，
 * 于是去改 recipe、改选择器、改等待时间，而真正的原因是这一轮压根没人收键鼠。
 *
 * 它是**提示不是判决**：不是所有应用在锁屏下都聋（自绘的 Win32 应用照常收），所以这里只报
 * 事实（前台是谁），不替调用方下"就是因为锁屏"的结论。
 */
async function annotateInputSurface(
  recipe: DesktopRecipe,
  driver: DesktopDriver,
  out: DesktopRunOutcome,
): Promise<DesktopRunOutcome> {
  if (out.outcome !== 'drift' || recipe.input !== 'message') return out
  let fg: { process: string; title: string } | undefined
  try {
    fg = (await driver.windows()).find((w) => w.foreground)
  } catch {
    // 连窗口都列不出来时别把这一层的失败盖到原因上——原来那句才是人要看的。
    return out
  }
  const locked = !fg || LOCK_SCREEN_PROCESSES.includes(fg.process.toLowerCase())
  if (!locked) return out
  const who = fg ? `前台是 ${fg.process}` : '此刻没有任何前台窗口'
  return {
    ...out,
    driftReason:
      `${out.driftReason ?? '（没给原因）'}；顺带：这一轮跑的时候屏幕锁着（${who}）` +
      '——投给窗口的键鼠在这一档可能被应用整轮静默丢弃（PostMessage 照样返回成功），先解锁再重跑一遍再判 recipe 有没有问题',
  }
}

async function runDesktopRecipeLocked(
  recipe: DesktopRecipe,
  params: Record<string, string>,
  driver: DesktopDriver,
  /** 宿主注入的识别层工厂——**一趟一个实例**（`modelCalls` 的账归这一趟）。没传 = 这个宿主
   *  不支持 `see`，用了 `see` 的 recipe 会当场 drift 而不是安静地少做一步。 */
  makeSee?: (driver: DesktopDriver) => SeeResolver,
  now: () => number = Date.now,
  /** 介入闸的收件人（见 `RepairProposal`）。默认只打日志——**接缝不是功能**。 */
  repairRunner: RepairRunner = new LoggingRepairRunner(),
  /** 见 `runDesktopRecipe` 的 `opts.facility` 头注：只透传，不在这里推导。 */
  facility?: string,
  /** 见 `runDesktopRecipe` 的 `opts.stepGate` / `opts.onProbe`。 */
  debug: { stepGate?: StepGate; onProbe?: (msg: string) => void; overrides?: OverrideSource; packageInfo?: { name: string; version: string } } = {},
): Promise<DesktopRunOutcome> {
  let typedVia: DesktopRunOutcome['typedVia']
  /** 这一趟里**任何**一次 find 报回来的「树可能还没建」。记住它，因为报旗的那次 find 常常
   *  不是判失败的那一步（登录墙读空不判失败，但它已经在说"整棵树都没读到"了）——见
   *  `A11yFindResult.unbuilt`。 */
  let unbuilt: string | undefined
  /** 每次 find 都过这里：取元素、顺手把旗收进 `unbuilt`。漏走一处，那次的旗就丢了。 */
  const find1 = async (q: A11yQuery) => {
    const r = await driver.find(q)
    if (r.unbuilt) unbuilt = r.unbuilt
    return r.elements
  }
  /**
   * 定位一个 recipe 查询。`nameAnyOf` 在**这里**展开成若干次普通 find（见 `DesktopQuery`）——
   * 不上 wire，agent 不用认识它。逐个试、第一个命中就用；候选之间不比较优劣，顺序即优先级。
   */
  const find = async (q: DesktopQuery): Promise<A11yElement[]> => {
    if (!q.nameAnyOf?.length) return find1(q)
    const { nameAnyOf, ...rest } = q
    for (const name of nameAnyOf) {
      const els = await find1({ ...rest, name: substitute(name, params) })
      if (els.length > 0) return els
    }
    return []
  }
  const seeResolver = makeSee?.(driver)
  const seeVia: Record<string, SeeVia> = {}
  /** 这一趟消化掉的打断（见 `DesktopRunOutcome.dismissed`）。 */
  const dismissed: string[] = []
  /** 这一趟被 `branch` 跳过的步骤（见 `DesktopRunOutcome.skipped`）。 */
  const skipped: string[] = []
  /** 成立的那些 `branch.unverified`（见 `DesktopRunOutcome.unverified`）。 */
  const unverified: string[] = []
  /** 每个 `pickFile` 步骤的回执（见 `DesktopRunOutcome.pickFile`）。 */
  const pickFiles: Record<string, PickFileReceipt> = {}
  /** 这一趟每步真正走通的那条落地方式——`done` 之后交给本机账本（只记走通的，失败的一条都不记）。 */
  const used: UsedGrounding[] = []
  /** 同一份东西给人读的形状（`DesktopRunOutcome.groundings`）：失败的一趟也带着它，
   *  否则"在哪条落地方式上倒的"只能靠猜。 */
  const usedTags: Record<string, string> = {}
  /** 哪个键是哪一步记的。**两步共用一个 label 不能互相盖掉**（`seeVia` 是给人读"这一趟每步
   *  走了哪条路"的，少一行就等于其中一步查不动）；而同一步重来一次（Task 7 的 retry）该覆盖
   *  自己那一行，所以按"记它的是不是同一步"分，不是按"这个键在不在"分。 */
  const seeKeyOwner: Record<string, number> = {}
  const stepKey = (i: number, step: { label?: string }) => {
    const base = step.label ?? `#${i}`
    if (!(base in seeKeyOwner) || seeKeyOwner[base] === i) {
      seeKeyOwner[base] = i
      return base
    }
    return `${base}#${i}`
  }
  /** 填参：报出去、缓存进去的都得是**这一趟真正找的那个东西**，不是模板。和 `subQuery` 同一个
   *  理由——诊断里看见 `{"text":"{contact}"}` 的人不知道找不到的是哪个人。 */
  /** **`See` 里每一格能带 `{param}` 的都要在这儿列一行。** 漏掉一格不报错——那一格会把花括号
   *  原样送下去（`point` 漏掉就是把「{contact}的输入框」整串发给模型），而模型多半还会
   *  一本正经地指一个地方。 */
  const fillSee = (see: See): See => ({
    ...see,
    ...(see.text ? { text: substitute(see.text, params) } : {}),
    ...(see.icon ? { icon: substitute(see.icon, params) } : {}),
    ...(see.point ? { point: substitute(see.point, params) } : {}),
  })
  /**
   * **这一步**最后一次 `locate` 的命中（每步开头清空）。自愈要作废的就是它：模板是"上次模型
   * 指的那一刀"冻下来的，界面改版后它照样能匹配到一个分数够高的地方——每趟都命中、每趟都点空，
   * 而 `seeVia` 上写着 `template`，看起来比模型那条路还稳。expect 是唯一能戳破它的信号。
   */
  // 读它必须经 `lastHit()` 而不是直接读这个变量：`locate` 的回填在闭包里，tsc 的控制流看不见，
  // 直接读会被一路收窄成 `null`（读 `.via` 报 never）。过一次函数调用，拿到的就是声明类型。
  const last: { hit: SeeHit | null } = { hit: null }
  const lastHit = (): SeeHit | null => last.hit
  /**
   * 把一个 `see` 变成一个框（屏幕物理坐标）。宿主没配识别层 → 抛 `SeeUnavailable`（步骤循环
   * 翻成 drift）：那不是"界面变了"，把它混进 drift 的普通失败里会让人去改 recipe。
   *
   * **模型段有一趟的总量上限**：`≤ 步骤数`。识别层自己不知道"这一趟该花多少"，而一条走岔了的
   * recipe（每一步都落到模型段）在活体上就是每轮烧一次钱且没人喊。
   *
   * 上限**只关掉模型那一段**，不拦整趟梯子：a11y / 屏幕文字 / 模板都是免费的，把它们一起停掉
   * 等于把"省钱"变成"预算用完之后每一步必然失败"。失败那句话也要说清是预算用满了——
   * 见 `seeMiss`。
   */
  /** 具名区域换成 `region` + 填参。`locate` 与 `expect.fresh` 两条路共用这一份——两份各写各的，
   *  迟早一边换了区域、另一边还在读整窗。 */
  const groundSee = (see: See): See => {
    // 具名区域在这里、也只在这里换成那一块的 `region`：识别层只认 `region`，`area` 漏换的
    // 表现是那格被当成不认识的键丢掉、判据回到整窗——慢一个量级，却照样"成立"。
    // **区域还没查表就被引用**：只可能是第一步那个 `window` 步骤自己的 `require` / `expect` 用了
    // `area`——那一步跑完事实才学全，查表推迟到它之后（见 `resolveAreas`）。**当场报出来**，别
    // 让它变成一个读不到 `.region` 的 TypeError：那句话指向引擎内部，而真正该改的是这份 recipe
    // （把判据挪到下一步，或给那块区域写一条通用 `region`）。
    if (see.area && !areaRegions.has(see.area)) {
      throw new SeeUnavailable(`区域「${see.area}」在第一步（window）里就被判据引用了，而这一步跑完才学得到平台/版本——把这条判据挪到 window 步之后`)
    }
    const grounded = see.area ? (() => { const { area, ...rest } = see; return { ...rest, region: areaRegions.get(area)!.region } })() : see
    return fillSee(grounded)
  }
  /** `expect.fresh` 的"动作前"那张位置清单（每个动作步开头重取，见步骤循环里的预检）。 */
  let freshBaseline: Rect[] = []
  const locate = async (
    see: See,
    i: number,
    step: { label?: string },
    allowModel: boolean,
    /**
     * 这次定位算不算"这一步的靶子"。**判据那次一律 false**：`seeVia` 回答的是「这一步的靶子
     * 是怎么找到的」，它存在的唯一理由是分得出"这条 recipe 稳了（模板）"和"它每轮都在烧
     * token（模型）"。判据每步都查、又专挑便宜的段走，记进去就会把动作那次的 `model` 覆盖成
     * `screen`——这一栏从此永远报便宜的那条路，字段的用途正好被反过来。`last.hit`（自愈要作废
     * 的那条模板）同理：要作废的是**动作**踩空的那个靶子。
     */
    record: boolean,
    /**
     * 查哪张表（见 `SeeMode`）。**由 `see` 出现的位置决定，不由 recipe 作者选**：动作步骤的
     * 目标和 `interrupts[].dismiss` 是要点的东西 → 元素表；`expect` / `require` / `branch.when`
     * / `interrupts[].see` 是"画面上写着什么" → 文字表。这是引擎强制的那一刀（spec §3）。
     */
    mode: SeeMode,
  ): Promise<SeeMiss & { hit: SeeHit | null }> => {
    if (!seeResolver) throw new SeeUnavailable('这条 recipe 用了 see，但宿主没配识别层（runDesktopRecipe 没传 opts.see）')
    const filled = groundSee(see)
    const capped = allowModel && seeResolver.modelCalls >= recipe.steps.length
    const callsBefore = seeResolver.modelCalls
    // `label` 只进排查记录：一条 trace 说不清是第几步的哪一次定位就没用（同一步的
    // `require` / 动作 / `expect` 会各查一次）。
    const hit = await seeResolver.resolve(filled, {
      allowModel: allowModel && !capped,
      mode,
      label: `${i}-${mode}-${step.label ?? ''}`,
      // recipe 的申报（`RecipeAppMatch.a11y`）在这里进识别层；缺省 true = 今天的行为。
      a11y: recipe.app.a11y ?? true,
    })
    // 「模型跑了没」看计数，不看"允许没允许"：允许了也可能没跑（没配模型、候选框一个都没有、
    // 两次抓拍尺寸对不上）。活体 2026-09-07 就撞过一次——OCR 漏认了「搜索」，候选里压根没有它，
    // 模型如实答"没有"，而这里若照"允许"报成"模型也落空"，读的人会去查一个界面上明明在的字。
    const modelRan = seeResolver.modelCalls > callsBefore
    if (hit && record) {
      seeVia[stepKey(i, step)] = hit.via
      last.hit = hit
    }
    // 只记**肯定结论**：这一块屏上真的读到了那句话，才算这块区域画对了。落空那次什么都没证明
    // （也许只是界面还没变），记下去就会把一块画歪的区域攒够次数推上游。
    if (hit && mode === 'read' && see.area) areasHit.add(see.area)
    return { hit, filled, capped, modelRan, modelSkipped: allowModel && !capped && !modelRan }
  }
  /**
   * 「没找到」那句话。**走过哪几段要如实说**：预算用满时报"四段都落空"是句假话，照它去查界面
   * 查的是一件根本没发生过的事（模型段压根没跑）。`expect` 那条路同理——它一开始就不许调模型
   * （判据不花钱），报"四段都落空"会让人去查一段从来没跑过的东西。
   */
  // recipe 申报了 `app.a11y:false` 时，a11y 段在 `resolveSee` 里整段没跑（见 desktop-see.ts）——
  // miss 文案照旧说"a11y 也落空"就是在指一件从没发生过的事，读的人会去枉查控件树。
  const segments = recipe.app.a11y === false ? '屏幕文字 / 模板' : 'a11y / 屏幕文字 / 模板'
  const seeMiss = (what: string, m: SeeMiss, tail = '') =>
    `${what}：${JSON.stringify(m.filled)}（` +
    (m.modelRan
      ? `${segments}都落空，模型在候选框里也没认出它——目标多半没被 OCR 认出来（候选框只来自读屏），换个 see 或看 see-probe`
      : m.capped
        ? `本趟 model 段已用满 ${recipe.steps.length} 次预算，只走了 ${segments}`
        : m.modelSkipped
          ? `${segments}落空，模型段没跑（没配视觉模型 / 区域内没有可编号的候选框 / 两次抓拍尺寸不一致）`
          : `只走了 ${segments}——判据不调模型`) +
    tail + '）'

  // drift 的原因必须带上那面旗：「找不到目标」和「根本没读到」的 driftReason 今天一模一样，
  // 而它们的下一步完全相反（改选择器 vs 先 focus 那个窗口）。
  const blocked = (r: 'needsLogin' | 'challenged' | 'drift', reason: string | null = null): DesktopRunOutcome => ({
    outcome: r,
    items: [],
    driftReason: reason && unbuilt ? `${reason}——${unbuilt}` : reason,
    ...(typedVia ? { typedVia } : {}),
    ...(Object.keys(seeVia).length ? { seeVia } : {}),
    ...(dismissed.length ? { dismissed } : {}),
    ...(Object.keys(usedTags).length ? { groundings: usedTags } : {}),
    ...(unverified.length ? { unverified } : {}),
    ...(Object.keys(pickFiles).length ? { pickFile: pickFiles } : {}),
  })
  /** 步骤自带的人话（`label`）排在机器话前面——面向用户的 recipe 里，这一句就是给用户看的
   *  那句。没写 label 就退回原来的形状，不硬造。 */
  const stepFailed = (step: { label?: string }, machine: string) =>
    blocked('drift', step.label ? `${step.label}：${machine}` : machine)

  // **带 `edges[]` 的 recipe 当场拒，不往下跑。** 条件边本期只校验形状、不执行
  // （见 `DesktopRecipe.edges`），而"装载通过 + 安静地不生效"正是这条链路最贵的那种失败：
  // 作者以为那几步插进去了，实际一步没插，而每一步都照常报成功。发在一切动作之前——
  // 一个输入都不发，比发一半再说"其实没执行 edges"要好。
  if (recipe.edges?.length) {
    return blocked('drift', 'edges-unsupported：这份 recipe 带 edges[]，本期运行时不执行条件边')
  }

  /**
   * 一次即时读：`expect` 此刻成立吗。`see` 走梯子但**不许 model**——判据不花钱，而且一个
   * 会自己找靶子的判据等于让模型来判"这一步做成没有"，那就不是判据了。`query` 走 a11y。
   */
  const checkExpect = async (ex: DesktopStepExpect, i: number, step: { label?: string }): Promise<{ ok: boolean; miss: SeeMiss | null }> => {
    // 装载期已经保证 see / query 恰好给一个（`recipe-store.ts`）。
    if (ex.fresh && ex.see) {
      // 冒没冒出一个动作前没有的位置（见 `DesktopStepExpect.fresh`）。读不了屏当"没看见"——
      // 和普通判据落空同一个结论，那句话里的 filled 照样说得清查的是什么。
      const filled = groundSee(ex.see)
      const seen = (await seeResolver!.matches(filled, { label: `${i}-fresh-${step.label ?? ''}` })) ?? []
      const ok = seen.some((r) => !freshBaseline.some((b) => sameSpot(r, b)))
      return { ok, miss: ok ? null : { filled, capped: false, modelRan: false, modelSkipped: false } }
    }
    if (ex.see) {
      // `record: false` —— 判据走的路不算这一步的靶子，见 `locate` 那个参数的注释。
      // `mode:'read'` —— 判据问的是"画面上写着什么"，查文字表；带 region 时它还会被下推给
      // agent，一步从整窗的一两秒降到几十毫秒。
      const { hit, ...miss } = await locate(ex.see, i, step, false, false, 'read')
      return { ok: hit != null, miss }
    }
    return { ok: (await find(subQuery(ex.query!, params))).length > 0, miss: null }
  }
  /**
   * 动作之后轮询到成立或超时。默认 3s——界面反应通常在几百毫秒内，等不到就是真没发生。
   * 回最后一次的 `SeeMiss`：失败那句话要说清**走过哪几段**（判据这条路压根不许调模型）。
   *
   * **超时是墙钟，不是轮数。** 一轮 = 一次完整的读屏（PrintWindow + OCR；带 region 的判据
   * 几十毫秒，整窗要一到三秒），
   * 按 `timeoutMs / 300` 数轮数等于把每轮的开销当成 0：`timeoutMs:3000` 名义上等 3 秒，实际
   * 可能等了十几秒，而报出来的那句仍然写着「等了 3000ms」——照它去查，会得出"界面 3 秒内
   * 没反应"这个假结论，真相是我们自己读得慢。所以按 deadline 判，并且**报真花掉的那个数**。
   *
   * 一定至少查一次（`timeoutMs` 再小也要看一眼）；只有"睡完还有时间"才睡——睡完就超时的
   * 那一觉之后没有人再看一眼，纯粹是每步白等 300ms。
   *
   * **`elapsed` 只算这一次等待，不是这一步的总耗时。** 消化过打断之后的那次重验是另一次
   * 调用、另一段计时，报出来的是**第一次**那段。这是有意的：这个数回答的是「给了它多久去
   * 兑现」，而消化打断本身要花的时间（读屏 + 抢屏 + 一次点击）不是界面在慢，把它算进来会让
   * 「等了 1200ms」在一条 `timeoutMs:1000` 的步骤上冒出来，读的人第一反应是超时算错了。
   * 要看这一步整体花了多久，读探针那几行时间戳（`[desktop-probe]`）。
   */
  const awaitExpect = async (ex: DesktopStepExpect, i: number, step: { label?: string }) => {
    const timeoutMs = ex.timeoutMs ?? 3000
    const t0 = now()
    const deadline = t0 + timeoutMs
    let r: { ok: boolean; miss: SeeMiss | null } = { ok: false, miss: null }
    let rounds = 0
    for (;;) {
      rounds++
      r = await checkExpect(ex, i, step)
      if (r.ok) break
      if (now() + EXPECT_POLL_MS >= deadline) break
      await driver.sleep(EXPECT_POLL_MS)
    }
    return { ...r, elapsed: now() - t0, rounds }
  }

  // 限定 find/readSubtree 的搜索范围，**不抢屏**。两件事必须分开：不限范围就是在整个桌面上
  // 搜，别的窗口的元素会漏进结果（真撞过）；而抢屏是坐标/键盘输入的前提，只有真要发出那种
  // 输入时才该做——见下面的 `foreground()`。
  //
  // **第一步就是 `window` 时跳过这一次**：那一步的职责正是"从同一个进程的一堆窗口里认出该操作
  // 的那个"，而 agent 的 `scopeWindow` 遇到多个窗口匹配会**直接报错**（ambiguous-window，这是
  // 对的——它不该替调用方猜）。不跳过的话，凡是"一个进程开多个窗口、由 recipe 自己挑"的流程
  // 都会在第一步之前就死掉，而报出来的原因指向 `app` 写得不够细——恰恰相反，那正是 `window`
  // 步骤存在的意义。活体撞到（2026-08-31，代装扩展）：chrome.exe 当时有 4 个窗口。
  // `app.process` 写成一组候选（跨平台的名字）时先落成具体那一个：agent 的协议只认一个名字。
  // 判据是「屏上有哪个」，一次 `windows()` 就够；一个都不在也照样往下走——`scopeWindow` 会以
  // 「找不到 + 此刻在的窗口清单」失败，那句话比在这里另造一种错更有用。
  //
  // **第一步就是 `window` 的 recipe 也要先问一次窗口清单**：那条路上开头这一次 `scopeWindow` 不发，
  // 而事实（平台 / 应用版本）只从窗口行上来——不问就是空事实，于是那种 recipe 的每一步都只剩通用
  // 落地方式可选，而探针还会一本正经地报「agent 没报平台（老 agent）」。**那句话是假的**，照它去查
  // 会去升级一个本来就在报平台的 agent。
  const winList =
    Array.isArray(recipe.app.process) || recipe.steps[0]?.kind === 'window' ? await driver.windows() : undefined
  // `a11y` 是给识别层的申报，不是窗口匹配条件——别让它跟着 `match` 上 wire。
  const { a11y: _a11y, ...appOnly } = recipe.app
  const app: AppMatch = Array.isArray(appOnly.process)
    ? concretizeApp(appOnly, winList!)
    : (appOnly as AppMatch)
  /** agent 报的事实（`WindowInfo.platform` / `appVersion`）。**从 agent 来，不从 process.platform 来**：
   *  后端可能跑在 WSL 上而 agent 在 Windows，拿本进程的平台去挑落地方式会挑到一份根本不该用的。 */
  const facts: GroundingFacts = {}
  const learnFacts = (w: { platform?: 'win32' | 'darwin'; appVersion?: string } | undefined) => {
    if (!w) return
    if (w.platform && !facts.platform) facts.platform = w.platform
    if (w.appVersion && !facts.appVersion) facts.appVersion = w.appVersion
  }
  /**
   * 从窗口清单学事实，**两格的来源不一样**：
   *
   * - `platform` 是**整台机器**的事实——桌面上任何一行窗口都在回答同一个问题，学谁的都一样。
   * - `appVersion` 只能从**这个应用自己**的窗口行上学：随手拿一行（别的进程的弹层、桌面上
   *   碰巧在的别的窗口）学来的版本号是另一个应用的，而它会被拿去挑落地方式、写进记账。
   *
   * 两格都按「是自己的窗口」过滤的代价是静音的：第一步就是 `window` 的 recipe，开头那一次
   * `windows()` 常常还看不到自己的窗口（它就是来等它出现的），于是平台跟着一起丢——每一步
   * 只剩通用落地方式可选，外加一句假的「agent 没报平台（老 agent）」。
   */
  const learnFromWindow = (w: { process: string; platform?: 'win32' | 'darwin'; appVersion?: string } | undefined) => {
    if (!w) return
    if (w.platform && !facts.platform) facts.platform = w.platform
    if (w.appVersion && !facts.appVersion && processMatches(app.process, w.process)) facts.appVersion = w.appVersion
  }
  if (winList) for (const w of winList) learnFromWindow(w)
  if (recipe.steps[0]?.kind !== 'window') learnFacts(await driver.scopeWindow(app))

  /** 当前范围所在的那个窗口。**`window` 步骤会把它换掉**——换了之后抢屏也得跟着换，
   *  否则会出现"在对话框里找控件、却把 Chrome 主窗口抬到前台"这种各自成立、合起来错的组合。 */
  let scoped = app
  // OCR 范围（`scoped`）和抢前台目标（`foregroundTarget`）通常是同一个窗口，但对「随主窗活着的
  // 弹层」（`window.ownedPopup`，微信搜索候选那种）要分开：范围切到弹层去找候选，前台却得保持在
  // 主窗——抬弹层会让主窗失焦、弹层当场关掉。默认两者相等，只有 ownedPopup 那一步把前台目标钉在主窗。
  let foregroundTarget = app

  /**
   * 坐标/键盘输入之前抢屏。**惰性且每次重来**：一份全走 invoke 的 recipe 一次都不会调它；
   * 而调过一次也不等于此后一直在前台（用户随时会切走），所以每个坐标步骤各抢各的。
   *
   * **抬不上来必须当场停手，并且报出「现在是谁占着前台」。** `focusApp` 的返回值是回读出来的
   * 「它现在真的在前台吗」（见 `DesktopDriver.focusApp`），不是「我调用过了吗」——丢掉它，
   * 下一个坐标 op 会被 agent 的闸门以 `no-foreground-target: 还没确立目标窗口` 拒掉，那句话
   * 读起来像我们的代码漏了一步 focusApp。
   *
   * 报**占着前台的那个窗口的标题**，而不是列一串可能的原因：活体实测（2026-08-31，win-test）
   * 的真因是系统弹了个 Node.js 的防火墙授权框、一直占着前台，人不点它谁也抢不过来——这种事
   * 猜不出来，但窗口标题一说就明白。（同一台机器上验过：**提权与否不是原因**，`/rl highest`
   * 那一档照样成功——别再把"是不是管理员身份跑的"写回这句话里。）
   */
  /** `input:"message"` 的 recipe：坐标 op 投给窗口本身，一次都不抢前台（见 `DesktopRecipe.input`）。 */
  const deliver = recipe.input
  const foreground = async () => {
    // 消息投递有收件人（scope 到的窗口），不需要前台——`focus` 步骤在这条路上只剩"限定范围"，
    // 而范围在开头的 scopeWindow 就已经定了。
    if (deliver) return
    let ok: boolean
    try {
      ok = await driver.focusApp(foregroundTarget)
    } catch (e) {
      // agent 自己认出了是谁挡着（`desktop-locked:` 等，`<code>: <人话>` 形状）就会以错误回，
      // 而不是回 false——那句话就是最准的诊断，直接当这一步的 drift 报出去。活体 2026-09-07
      // （本机锁屏）：不接住它，它作为未知异常一路炸到调用方，预览里是 `category:"unknown"`、
      // `run_action_recipe` 直接抛——而正确的下一步（解锁）就写在那句话里。认不出前缀的照抛。
      const msg = e instanceof Error ? e.message : String(e)
      if (classifyDesktopError(msg)) throw new ForegroundRefused(msg)
      throw e
    }
    if (ok) return
    const holder = (await driver.windows()).find((w) => w.foreground)
    throw new ForegroundRefused(
      `没能把「${foregroundTarget.title ?? foregroundTarget.process}」抬到前台` +
      (holder
        ? `——此刻占着前台的是「${holder.title}」（${holder.process}）。它让开之后再试。`
        : '——也看不出是谁占着，屏幕可能锁着、或者这个会话没人连着。') +
      '这一步要发的是键盘/鼠标输入，没有前台就没有收件人，所以停手。',
    )
  }

  // Login wall short-circuits to needsLogin — never drift (parallel to the browser abort-on-wall).
  if (recipe.loginCheck) {
    if ((await find(subQuery(recipe.loginCheck.wall, params))).length > 0) return blocked('needsLogin')
  }

  // Pre-read steps, in order.
  //
  // **每一步都留一行时间戳**（`[desktop-probe]`，与浏览器那条链路的 `[recipe-probe]` 同形状）。
  // 桌面这一侧没有 DevTools、没有 DOM 快照，一步做完屏幕上就没有痕迹了——出问题时手里只有
  // 一句 driftReason，既不知道前面几步各花了多久，也不知道失败那一刻之前发生了什么。这一行
  // 是唯一能事后重建时序的东西（活体实测：文件夹对话框"看见了又没了"的真因，全靠这几行毫秒
  // 数才定得下来是**上一步耗时太长**而不是有人替我们按了确认）。
  const t0 = Date.now()
  const probe = (msg: string) => {
    const line = `+${Date.now() - t0}ms ${msg}`
    console.log(`[desktop-probe] ${recipe.sourceId} ${line}`)
    debug.onProbe?.(line)
  }
  if (deliver) probe(`input=${deliver}（坐标输入投给窗口，整轮不抢前台）`)
  // 本机那份和包里那份对一次账——**在第一次 rankGroundings 之前**，否则这一趟读到的还是上一
  // 版的本机落地方式（理由见 `OverrideSource.reconcile` 头注）。没变化就一个字都不说。
  if (debug.overrides?.reconcile) {
    const { removed, shadowed } = debug.overrides.reconcile(recipe.sourceId, recipe)
    if (removed + shadowed > 0) probe(`[recipe-overrides] ${recipe.sourceId}: 已上游 ${removed} 条、被包覆盖 ${shadowed} 条`)
  }

  const areaRegions = new Map<string, ResolvedArea>()
  const areaTags: Record<string, string> = {}
  let areasResolved = false
  /**
   * 每块具名区域按事实查一次表（spec §3.4）。**在发出任何输入之前**：一块都选不中就整趟不跑——
   * 跑到那一步才发现的话，前面的动作已经做了。同一趟里事实不变，所以只查这一次。
   * 返回 `blocked(...)`（整趟到此为止）或 null（都查到了）。
   *
   * 住在对账**之后**：本机那份刚被删/标 shadowed 的行不该再参与这一次选择。
   *
   * **什么时候调见两个调用点**——关键是它必须晚于「事实学完」。第一步是 `window` 的 recipe
   * 开头那次 `windows()` 里常常还没有自己的窗口（那一步正是来等它出现的），此时 `facts` 是空的，
   * 而后面每步的 `rankGroundings` 吃的是学全之后的事实。在这里查表就会拿 `事实 {}` 去选区域：
   * 分平台那条一律不匹配，于是要么落回通用、要么以一句**诚实但错**的 `no-grounding@area:… 事实 {}`
   * 把整趟拦下来，而同一份 recipe 的步骤那一侧选得好好的。
   */
  const resolveAreas = (): DesktopRunOutcome | null => {
    areasResolved = true
    for (const [name, area] of Object.entries(recipe.areas ?? {})) {
      const local = debug.overrides?.areaGroundingsFor?.(recipe.sourceId, name) ?? []
      const r = resolveArea(name, area, local, facts)
      if (!r) {
        const tried = [...(area.groundings ?? []), ...local].map((g) => `${g.on?.platform ?? '*'}${g.on?.app ? `@${g.on.app}` : ''}`).join('、') || '（没有一条）'
        return blocked('drift', `no-grounding@area:${name}：没有一条落地方式与事实相符（事实 ${JSON.stringify(facts)}；有的：${tried}；顶层 region ${area.region ? '有' : '无'}）`)
      }
      areaRegions.set(name, r)
      areaTags[name] = r.tag
      probe(`区域「${name}」← ${r.tag}（${JSON.stringify(r.region)}）`)
    }
    return null
  }
  // 第一步不是 `window` 的 recipe：事实在上面那次 `scopeWindow` 就学全了，此刻查表。
  if (recipe.steps[0]?.kind !== 'window') {
    const b = resolveAreas()
    if (b) return b
  }
  /** 这一趟里哪些区域帮某条判据得出过肯定结论——记账用，一块只记一次。 */
  const areasHit = new Set<string>()
  /**
   * 把区域的记账并进 `used`。**只并肯定结论**：判据落空那次什么都没证明，而动作前那次"必须
   * 还不成立"的检查命中是整趟失败、根本走不到记账。
   */
  const flushAreaUse = () => {
    for (const name of areasHit) {
      const r = areaRegions.get(name)!
      // 通用那条不是"学到的落地方式"，同 steps：只记带 `on` 的。
      if (r.universal) continue
      used.push({ area: name, body: { region: r.region }, on: r.on, by: r.verified?.by ?? (r.source === 'local' ? 'ai' : 'author') })
    }
  }

  /** 打断表 = recipe 自带的那张 ∪ 这台机器攒下来的那张（见 `SeeResolver.localInterrupts`）。 */
  const interruptTable = () => [...(recipe.interrupts ?? []), ...(seeResolver?.localInterrupts() ?? [])]
  /**
   * expect 不成立时问一句「是不是被打断了」：表里第一条能在屏幕上找到的，就执行它的 dismiss。
   *
   * **只在 expect 失败之后才来这里**，正常路径一次多余的读屏都不发——绝大多数步骤根本没有弹窗，
   * 每步都查等于给整条 recipe 加一份白花的时间，而它表现出来的样子是"识别层怎么这么慢"。
   *
   * **表里没有 → 返回 false，交给 else**。不认识的界面上一个输入都不发：一个"看见没见过的框
   * 就随便按一下"的兜底，在桌面这一侧就是替用户点了「确认删除」——而它每一次都会"成功"。
   */
  const tryDismiss = async (i: number, step: { label?: string }, table = interruptTable()): Promise<boolean> => {
    for (const it of table) {
      // `allowModel:false` —— 关弹窗不该花钱；`record:false` —— 弹窗不是这一步的靶子，
      // 写进 `seeVia` 就会把动作那次的路径覆盖掉（同 `locate` 那两个参数的注释）。
      // `mode:'read'` —— 这一问是"屏幕上有没有这句话"（认弹窗），不是"点哪儿"；点的是下面
      // 那个 `dismiss`。
      const { hit } = await locate(it.see, i, step, false, false, 'read')
      if (!hit) continue
      probe(`#${i} 打断命中 ${JSON.stringify(it.see)} → dismiss ${it.dismiss.kind}`)
      if (it.dismiss.kind === 'press') {
        await foreground() // 按键投给焦点窗口，没有前台就是按在别人的窗口上
        await driver.press(it.dismiss.key, deliver)
      } else {
        // 两道闸的第二道（第一道是装载/读盘时的 `validateInterrupt`）：`see` 和 `query` 一个都
        // 没有时，下面那个 `subQuery(query!)` 会变成 `find({})`——窗口里的**第一个元素**，然后
        // invoke 它。宁可这一条不生效，也不能替用户按一个谁也不知道是什么的按钮。
        if (!it.dismiss.see && !it.dismiss.query) {
          console.warn(`[desktop] 打断 ${JSON.stringify(it.see)} 的 dismiss 既没 see 也没 query，跳过`)
          continue
        }
        // 关闭按钮通常不是弹窗本体那个框（"稍后再说"是文字、右上角还有个 ×），所以
        // dismiss 可以另指一个目标；不指就退回用识别到弹窗的那一段自己。
        // `mode:'action'` —— 这一个是真要按下去的东西（「稍后再说」那个按钮），查元素表。
        const target = it.dismiss.see
          ? (await locate(it.dismiss.see, i, step, false, false, 'action')).hit
          : (await find(subQuery(it.dismiss.query!, params)))[0]
        // 认得出弹窗、却点不到它的关闭按钮：**这不算消化过**，交给 else 去判——报一句
        // "已消化"而屏幕上那个框还在，比不消化更难查。
        if (!target) return false
        const ref = 'ref' in target ? target.ref : target.a11yRef
        if (ref) await driver.invoke(ref)
        else {
          await foreground()
          await driver.click(target.rect, undefined, undefined, deliver)
        }
      }
      dismissed.push(JSON.stringify(it.see))
      return true
    }
    return false
  }
  /**
   * `pickFile`：喂一个已经弹出来的系统文件对话框（语义见 `DesktopStepKind` 里它的头注）。
   *
   * 形状是「换范围到对话框 → 写路径 → 确认 → 等它消失 → 换回来」，**范围与前台目标在任何出口都换回**
   * ——失败也换：整趟到此为止时下一趟不该从一个已经不存在的窗口开始。
   *
   * 各段计时进回执：整条 `wechat-send-file` 慢在对话框之外（找联系人、图标走模型），对话框段本身
   * 不到 2s（活体 2026-09-18）；没有分段数字，"这一步慢"会被归到这里来。
   */
  const pickFile = async (step: Extract<DesktopStep, { kind: 'pickFile' }>, i: number): Promise<'ok' | DesktopRunOutcome> => {
    const key = stepKey(i, step)
    const t0 = now()
    const receipt: PickFileReceipt = { ms: { total: 0 } }
    pickFiles[key] = receipt
    const fail = (stage: 'dialog-missing' | 'edit-missing' | 'set-value-failed' | 'dialog-still-open', why: string) => {
      receipt.ms.total = now() - t0
      return stepFailed(step, `pickFile/${stage}：${why}`)
    }
    const path = substitute(step.path, params)
    const platform = facts.platform === 'darwin' ? 'darwin' : 'win32'
    // 对话框怎么认：recipe 给了就用它（标题照填参），没给按平台取默认。进程默认是 `app` 的——对话框是
    // 应用自己弹的（微信实测就在 Weixin.exe 里）。
    const match: DesktopWindowMatch = step.dialog
      ? {
          ...step.dialog,
          ...(step.dialog.title !== undefined ? { title: substitute(step.dialog.title, params) } : {}),
          ...(step.dialog.titleAnyOf ? { titleAnyOf: step.dialog.titleAnyOf.map((t) => substitute(t, params)) } : {}),
        }
      : { ...(app.process ? { process: app.process } : {}), titleAnyOf: PICK_FILE_DIALOG_TITLES[platform] }
    const prevScoped = scoped
    const prevForeground = foregroundTarget
    const listNow = async () => (await driver.windows()).map((w) => `${w.title}(${w.process})`).join('、') || '（一个都没有）'

    // 1. 等它出现
    const win = await waitForWindow(driver, match, step.timeoutMs ?? PICK_FILE_APPEAR_MS, now)
    receipt.ms.appear = now() - t0
    if (!win) {
      return fail('dialog-missing', `等了 ${receipt.ms.appear}ms 没等到文件对话框 ${JSON.stringify(match)}——多半是前一步没把它弹出来；此刻在的窗口：${await listNow()}`)
    }
    receipt.dialog = { process: win.process, title: win.title }
    learnFromWindow(win)
    probe(`#${i} pickFile 对话框 「${win.title}」 (${win.process}) +${receipt.ms.appear}ms`)
    // 对话框是独立的模态窗口、自己就该拿焦点（和微信候选那种 owned popup 相反）——前台目标跟着换。
    // mac 的面板是主窗里的 sheet，抬主窗即可。
    const dialogScope: AppMatch = { process: win.process, title: win.title }
    const restore = async () => {
      scoped = prevScoped
      foregroundTarget = prevForeground
      // 换回失败不盖过正在报的原因：对话框还开着时 scope 回主窗照样成功，真失败只会是主窗自己没了。
      await driver.scopeWindow(prevScoped).catch((e) => probe(`#${i} pickFile 换回「${prevScoped.title ?? prevScoped.process}」失败：${(e as Error).message}`))
    }
    try {
      await driver.scopeWindow(dialogScope)
    } catch (e) {
      return fail('dialog-missing', `对话框「${win.title}」在被 scope 之前就消失了（${(e as Error).message}）；此刻在的窗口：${await listNow()}`)
    }
    scoped = dialogScope
    foregroundTarget = platform === 'darwin' ? app : dialogScope
    /** 等某个控件进树（窗口标题先变、界面后建——同 `window.waitFor`）。 */
    const awaitControl = async (q: DesktopQuery, timeoutMs: number): Promise<A11yElement | undefined> => {
      const deadline = now() + timeoutMs
      for (;;) {
        const els = await find(q)
        if (els.length > 0) return els[0]
        if (now() + WINDOW_POLL_MS >= deadline) return undefined
        await driver.sleep(WINDOW_POLL_MS)
      }
    }
    /** 对话框还在不在（按刚认出的那个真实标题 + 进程判，不按模板判——模板可能还匹配别的窗口）。 */
    const stillOpen = async () => (await driver.windows()).some((w) => w.process === win.process && w.title === win.title)
    const awaitClosed = async (timeoutMs: number): Promise<boolean> => {
      const deadline = now() + timeoutMs
      for (;;) {
        if (!(await stillOpen())) return true
        if (now() + WINDOW_POLL_MS >= deadline) return false
        await driver.sleep(WINDOW_POLL_MS)
      }
    }
    const closeTimeout = step.closeTimeoutMs ?? PICK_FILE_CLOSE_MS
    try {
      const tFill = now()
      if (platform === 'darwin') {
        // macOS（待活体验证）：面板上敲 `/` → 「前往文件夹」→ 写路径 → 回车 → OKButton / 再回车。
        await foreground()
        await driver.type('/', undefined, deliver)
        const edit = await awaitControl(PICK_FILE_GOTO_MAC, Math.max(WINDOW_POLL_MS, closeTimeout))
        if (!edit) return fail('edit-missing', `敲了 / 之后没等到「前往文件夹」的路径框 ${JSON.stringify(PICK_FILE_GOTO_MAC)}`)
        try {
          await driver.setValue(edit.ref, path)
        } catch (e) {
          return fail('set-value-failed', `写不进路径框：${(e as Error).message}`)
        }
        receipt.ms.fill = now() - tFill
        const tClose = now()
        await driver.type('\n', undefined, deliver)
        receipt.via = 'goto+enter'
        const ok = (await find(PICK_FILE_CONFIRM_MAC))[0]
        if (ok) await driver.invoke(ok.ref)
        else await driver.type('\n', undefined, deliver)
        if (!(await awaitClosed(closeTimeout))) {
          return fail('dialog-still-open', `确认之后等了 ${now() - tClose}ms 面板还在；此刻在的窗口：${await listNow()}`)
        }
        receipt.ms.close = now() - tClose
      } else {
        // Windows：文件名框 setValue → 让它拿焦点 → Enter；树里有「打开(O)」只当 Enter 没关掉时的备选。
        const edit = await awaitControl(PICK_FILE_EDIT_WIN, Math.max(WINDOW_POLL_MS, closeTimeout))
        if (!edit) {
          const near = (await find1({ role: 'Edit' })).map((e) => e.name).filter(Boolean)
          return fail('edit-missing', `对话框在、文件名框不在：${JSON.stringify(PICK_FILE_EDIT_WIN)}；同 role 在场的有：${near.slice(0, 20).join(' | ') || '（一个都没有）'}`)
        }
        let via: PickFileReceipt['via'] = 'value+enter'
        try {
          await driver.setValue(edit.ref, path)
        } catch (e) {
          // 不认 ValuePattern → 退回键盘打进这个框（先 invoke 让它拿焦点）。留痕，别静默。
          probe(`#${i} pickFile setValue 不成，退回键盘：${(e as Error).message}`)
          via = 'keyboard+enter'
          await driver.invoke(edit.ref)
          await foreground()
          await driver.type(path, undefined, deliver)
        }
        receipt.ms.fill = now() - tFill
        const tClose = now()
        // 让文件名框拿焦点再回车——不依赖确认键在不在树里（活体验过这条路）。
        if (via === 'value+enter') await driver.invoke(edit.ref)
        await foreground()
        await driver.type('\n', undefined, deliver)
        let closed = await awaitClosed(closeTimeout)
        if (!closed) {
          const btn = (await find(PICK_FILE_CONFIRM_WIN))[0]
          if (btn) {
            probe(`#${i} pickFile Enter 之后 ${now() - tClose}ms 对话框还在，改点「${btn.name}」`)
            await driver.invoke(btn.ref)
            via = 'button'
            closed = await awaitClosed(closeTimeout)
          }
        }
        if (!closed) {
          return fail('dialog-still-open', `确认之后等了 ${now() - tClose}ms 对话框「${win.title}」还在（路径打不开、或它弹了个错误框）；此刻在的窗口：${await listNow()}`)
        }
        receipt.via = via
        receipt.ms.close = now() - tClose
      }
      // 弱信号：对话框没了之后主窗回到前台没有。只记不判——图片这类没有文字判据的挂载只剩它可看。
      const fg = (await driver.windows()).find((w) => w.foreground)
      receipt.foregroundBack = fg ? processMatches(recipe.app.process, fg.process) : false
      receipt.ms.total = now() - t0
      probe(`#${i} pickFile via=${receipt.via} appear=${receipt.ms.appear}ms fill=${receipt.ms.fill}ms close=${receipt.ms.close}ms 主窗回前台=${receipt.foregroundBack}`)
      return 'ok'
    } finally {
      await restore()
    }
  }

  /**
   * 做完这一步的**动作本身**：`'ok'` = 做完了，`'skip'` = 这一步不用做（optional 的目标不在），
   * 返回一个 `DesktopRunOutcome` = 这一步失败、整趟到此为止。
   *
   * **它只管动作、不管验证**：`expect` 那一层包在外面的循环里，因为 `retry` 要把同一个动作
   * 原样再做一遍——两件事揉在一起的话，重试就得复制一遍整条 if/else 链。
   */
  const runStep = async (step: DesktopStep, i: number): Promise<'ok' | 'skip' | DesktopRunOutcome> => {
    if (step.kind === 'window') {
      // 标题也吃 `{param}`：聊天窗口的标题就是会话名（QQ 紧凑模式下每个会话独立成窗），
      // 「等 {contact} 那个窗口出现」是这类 recipe 的必经一步。
      const match: DesktopWindowMatch = {
        ...step.match,
        ...(step.match.title !== undefined ? { title: substitute(step.match.title, params) } : {}),
        ...(step.match.titleAnyOf ? { titleAnyOf: step.match.titleAnyOf.map((t) => substitute(t, params)) } : {}),
      }
      const win = await waitForWindow(driver, match, step.timeoutMs ?? 12_000, now)
      if (!win && step.optional) return 'skip'
      if (!win) {
        // **把此刻还在的窗口列出来**（同 scope 失败那句）：`window not found` 单独一句读起来
        // 像 match 写错了，而真相常常是那个窗口压根没标题、或者标题跟想的不是一回事——
        // 有了这张清单，一眼就分得出是"没出现"还是"出现了但认不出"。
        const now = (await driver.windows()).map((w) => `${w.title}(${w.process})`).join('、')
        // **报代入之后的 match，不是 recipe 里那份模板。** 报模板的话这句会写成
        // `title:"{contact}"`，读起来像参数没代进去——2026-09-07 活体上我自己就被它带偏过一次，
        // 跑去翻 substitute 的实现，而真相是窗口压根没出现。
        return stepFailed(step, `window not found: ${JSON.stringify(match)}；此刻在的窗口：${now}`)
      }
      probe(`#${i} window hit 「${win.title}」 (${win.process})`)
      learnFromWindow(win)
      // 认出来的是**具体那一个**窗口（标题带动态尾巴，原样的 match 可能还匹配到别的），
      // 所以后续范围钉在它的真实标题上，不是钉在模板上。
      scoped = { process: win.process, title: win.title }
      // OCR 范围永远跟着 scoped 走；前台目标只有非 owned-popup 才跟着换。owned popup（微信候选）
      // 保持前台在主窗——抬弹层会关掉它（见 `window.ownedPopup` 头注）。
      foregroundTarget = step.ownedPopup ? app : scoped
      try {
        await driver.scopeWindow(scoped)
      } catch (e) {
        // 刚刚还在、这一下就没了——**这句必须说清"它没了"，不是"它不存在"**。
        // `no-window-match` 原文读起来像 recipe 的 match 写错了，于是排查会往"标题是不是变了"
        // 上走；真相是窗口在这两次调用之间被关掉了（短命对话框），下一步完全不同。
        if (step.optional) return 'skip'
        const now = (await driver.windows()).map((w) => w.title).join('、')
        return stepFailed(step, `窗口「${win.title}」在被 scope 之前就消失了（${(e as Error).message}）；此刻还在的窗口：${now}`)
      }
      if (step.focus) await foreground()
      // 标题变了不等于界面建好了（见 `waitFor` 的注释）。等到那个控件真的出现为止。
      if (step.waitFor) {
        const q = subQuery(step.waitFor, params)
        // 墙钟超时（同 `waitForWindow`）：一轮 `find` 的开销不是 0。
        const deadline = now() + (step.timeoutMs ?? 12_000)
        let seen = false
        for (;;) {
          if ((await find(q)).length > 0) { seen = true; break }
          if (now() + WINDOW_POLL_MS >= deadline) break
          await driver.sleep(WINDOW_POLL_MS)
        }
        if (!seen && !step.optional) return stepFailed(step, `window is up but its UI never appeared: ${JSON.stringify(q)}`)
      }
    } else if (step.kind === 'focus') {
      // 显式抢屏：recipe 作者明写要抢就抢（惰性只针对"顺带需要前台"的那些步骤）
      await foreground()
      // `wake`：先发一下**真实**输入把渲染端叫醒（见 `DesktopStep` 的 `focus` 那一格）。
      // 只在投消息那条路上有意义——走屏幕的那条路本来发的就是真实输入，自带这个效果。
      if (step.wake && deliver) {
        // 窗口中心从截图回执里拿：`captureWindow` 是唯一同时给出窗口屏幕 rect 的那一口，
        // 而 `windows()` 只给 id/标题。拿不到就跳过——叫醒是尽力而为，不该因此让整趟失败。
        // **首选零位移的那一口**：同样是真实输入、同样叫得醒，但不挪用户的指针
        // （本机 2026-09-08 对照：零位移 4/4、挪到窗口中心 3/4）。老 agent 没有它 →
        // 落回 `moveMouse`，那条能叫醒但会把指针挪到窗口中心；用户正在拖东西时指针跳走
        // 是会出事的，所以它只是退路，不是默认。
        //
        // **两级台阶，不是二选一。** 零位移那一下今天叫不醒了（活体 2026-09-12 两轮：nudge 返回
        // 成功、抬前台也做了，`Document` 6 秒内始终 0 个，随后投进去的点击与打字整份被丢）：
        // 零位移的 `SendInput` 只落在指针此刻所在的那个窗口上，指针不在 QQ 上时 QQ 一个
        // `WM_MOUSEMOVE` 都收不到，而 Chromium 判"有人碰我"看的正是自己窗口上的输入。
        // 所以先试便宜的（不挪指针），等不到再上贵的（把指针真挪到窗口中心，让那一下落在它身上）。
        // 第二级仍是尽力而为：拿不到窗口 rect 就只能到此为止，交给后面每一步的 expect 说话。
        const awaitAwake = async (): Promise<boolean> => {
          // **等到"醒了"这件事读得出来为止，不睡一个魔法数。**
          //
          // 渲染端从挂起里回来要一会儿，而具体多久没人知道：睡 1.5 秒实测仍会漏
          // （`focus-spike wake` 那组第 1 轮、以及活体第 5 轮都输在这个空档上）。所幸"醒没醒"
          // **是读得出来的**——渲染端挂起时它的控件树整棵不在（`Document` 读回 0 个），醒着时
          // 就有。于是这里轮询那棵树，而不是赌一个时长。
          //
          // 用 `Document` 不用 `Edit` 当探针：`Edit`（消息输入框）只在开着某个会话时才有，
          // 而这一步跑在打开会话之前；`Document` 是渲染端的根，醒着就在。
          const deadline = now() + WAKE_TIMEOUT_MS
          for (;;) {
            if ((await driver.find({ role: 'Document' })).elements.length > 0) return true
            if (now() >= deadline) return false
            await driver.sleep(WAKE_POLL_MS)
          }
        }
        const moveOntoWindow = async (): Promise<boolean> => {
          const cap = await driver.captureWindow()
          if (!cap) return false
          await driver.moveMouse(cap.window.x + Math.floor(cap.window.w / 2), cap.window.y + Math.floor(cap.window.h / 2))
          return true
        }
        const nudged = await driver.nudge()
        let awake = nudged ? await awaitAwake() : false
        if (!awake) {
          if (nudged) probe(`#${i} 零位移叫醒等满 ${WAKE_TIMEOUT_MS}ms 控件树仍空——升到第二级：把指针挪到窗口中心`)
          if (await moveOntoWindow()) awake = await awaitAwake()
        }
        if (!awake) {
          // **叫不醒就在这里停，一个输入都别发。** 曾经是"照常往下走、让后面的 expect 说话"，
          // 前提是"睡着时投进去的输入被丢掉"。活体 2026-09-12 证明前提错了：两轮各打了一遍
          // 联系人名、每步 expect 都判失败、看上去什么都没发生——等渲染端后来被人碰醒，
          // 两遍字**一起**落进搜索框（「我我的手机的手机」）。输入不是丢了，是**排队了**，
          // 回放的时刻和当时的界面状态都不由我们控制；一条带回车的正文排在队里就是往不知道
          // 谁的会话里发。所以这一步判 drift 收场（锁屏也走这一档：`driftReason` 会带上"屏幕锁着"）。
          return stepFailed(step, `两级叫醒都等满 ${WAKE_TIMEOUT_MS}ms，控件树仍是空的——渲染端还挂着；睡着时投进去的输入会排队、等它醒来再一起回放，所以这一轮一个输入都不发`)
        }
      }
    } else if (step.kind === 'invoke' && step.see) {
      // `see` 指的靶子：识别层给框，路怎么走由它给的那一段决定。查**元素表**（要点的东西）。
      //
      // **`optional` 的步骤不上模型。** 本地四档落空之后还要不要问模型，看的不是目标类型，是
      // "这一步认不到有没有别的路"：`optional` 就是作者已经备好了第二条路（"左栏看得见他就
      // 直接点，看不见走搜索"），认不到**就是答案**，而且常常正是常态。拿模型去复核一个本地
      // 已经给了否定答案的问题，是白付一次远程调用——活体 2026-09-12 这一趟等了 31s，整轮 80s
      // 里最大的一块，把发消息推过宿主 60s 超时。必须找到的步骤（没标 optional）才让模型兜底。
      const { hit, ...miss } = await locate(step.see, i, step, !step.optional, true, 'action')
      if (!hit && step.optional) return 'skip'
      if (!hit) return stepFailed(step, seeMiss('see 没找到目标', miss))
      // a11y 段顺手把 ref 也给了 → 走原生 invoke 的快车道：不抢屏、不发坐标。
      // 只有识别层是"看"出来的（没有 ref）才必须抢屏按坐标点。
      if (hit.a11yRef && !step.fallbackClick) await driver.invoke(hit.a11yRef)
      else {
        await foreground()
        await driver.click(hit.rect, undefined, undefined, deliver)
      }
    } else if (step.kind === 'invoke') {
      // 诊断里报**填过参**的那个 query：报模板等于让读的人看见 `{"nameContains":"{channel}"}`，
      // 而真正要知道的是"找不到的是哪个频道"。
      const q = subQuery(step.query!, params)
      const els = await find(q)
      if (els.length === 0) {
        // **没找到时，把同 role 的邻居名字列出来。** 桌面这一侧没有 DevTools，"找不到"手里
        // 只有一句查询，而真正要知道的是"那当时有的是什么"——名字差一个字、界面语言不对、
        // 控件压根不在这个窗口的树里，三种情况的下一步完全不同，而它们的报错今天一模一样。
        // 这一行对 `optional` 的步骤同样要打：optional 的失败是**静默**的，没有它就永远
        // 查不动（实测：固定图标那一步空转 12 秒、什么都没留下）。
        const near = (await find1({ role: q.role })).map((e) => e.name).filter(Boolean)
        probe(`#${i} 找不到 ${JSON.stringify(q)}；同 role 在场的有：${near.slice(0, 40).join(' | ') || '（一个都没有）'}`)
      }
      // optional = 复位步骤：找不到就是"本来就不需要复位"，跳过（见 DesktopStep 的注释）
      if (els.length === 0 && step.optional) return 'skip'
      if (els.length === 0) return stepFailed(step, `invoke target not found: ${JSON.stringify(q)}`)
      // handle fast-path: native invoke; coordinate click is the explicit opt-in fallback
      if (step.fallbackClick) {
        await foreground() // 坐标点击投给屏幕，没有前台就是对着别人的窗口按
        await driver.click(els[0].rect, undefined, undefined, deliver)
      } else await driver.invoke(els[0].ref)
    } else if (step.kind === 'type' && step.see) {
      // `see` 定位的输入框**没有 setValue 快车道**：识别层给的是屏幕上的一个框，不是一个能写
      // 值的元素（a11y 段虽然带 ref，但那一段命中与否是识别层的内部路径，不该在这里分叉出
      // 两种打字语义——同一份 recipe 有时抢屏有时不抢，比一直抢更难查）。所以一律：点进去 + 键盘。
      const { hit, ...miss } = await locate(step.see, i, step, true, true, 'action')
      if (!hit && step.requireTarget) return stepFailed(step, seeMiss('type see 没找到输入框', miss))
      await foreground()
      if (hit) await driver.click(hit.rect, undefined, undefined, deliver)
      // 定位不到不判 drift（同 `typeInto` 的理由）：键盘那条路本来就不需要这个框，焦点是上一步
      // 给的。但**必须留痕**——打给"此刻的焦点"是这条路上最难事后重建的一种错。
      else console.warn(`[desktop] ${seeMiss('see 没定位到输入框', miss)}，退回键盘（打给此刻的焦点）`)
      await driver.type(substitute(step.text, params), undefined, deliver)
      typedVia = 'keyboard'
    } else if (step.kind === 'type') {
      const via = await typeInto(driver, step, params, foreground, find, deliver)
      if (via === 'no-target') {
        return stepFailed(step, `type target not found: ${JSON.stringify(subQuery(step.query!, params))}`)
      }
      typedVia = via
    } else if (step.kind === 'scroll') {
      await foreground() // 滚轮打给光标底下那个窗口
      await driver.scroll(step.dir, step.amount, undefined, deliver)
    } else if (step.kind === 'click') {
      // 坐标点击投给屏幕，谁在上面谁收下——必须先把目标窗口抢到前台（同 scroll）。
      // 坐标先填参再转数：写死的数与 `{param}` 两种写法同一条路。
      let x: number
      let y: number
      if (step.at) {
        // 按窗口比例：取一次当前范围窗口的 rect（`captureWindow` 的 `window`，与 `click` 同一套
        // 屏幕坐标口径——Windows 物理像素、mac 点，agent 各自保证一致），再换成屏幕坐标。
        // 比例出界（<0 或 >1）是 recipe 写错，不是运行时状态，当场拒。
        const { x: fx, y: fy } = step.at
        if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return stepFailed(step, `click.at 必须是 0..1 的比例：${JSON.stringify(step.at)}`)
        const cap = await driver.captureWindow()
        if (!cap) return stepFailed(step, 'click.at 需要窗口 rect，而这个 agent 截不了窗（老 agent / 没授权）')
        x = Math.round(cap.window.x + fx * cap.window.w)
        y = Math.round(cap.window.y + fy * cap.window.h)
        probe(`#${i} click at (${fx}, ${fy}) of ${JSON.stringify(cap.window)} → (${x}, ${y})`)
      } else {
        x = Number(substitute(String(step.x), params))
        y = Number(substitute(String(step.y), params))
        if (!Number.isFinite(x) || !Number.isFinite(y)) return stepFailed(step, `click 坐标不是数字：x=${step.x} y=${step.y}`)
      }
      await foreground()
      await driver.click({ x, y, w: 1, h: 1 }, undefined, undefined, deliver)
    } else if (step.kind === 'press') {
      // 步骤级 press 放行的键由装载期那条判据管（`PRESSABLE_KEYS`：只放行改变状态、不 actuate
      // 的键）。两个用途：`Escape` 是**有守卫的复位**（前面一个 `branch` 先判状态干不干净，
      // 只有不干净才走到这里；按没按对由下一步的目标找不找得到兜住），`Tab` 是**挪焦点**
      // （空输入框在识别层没有靶子可指时唯一的办法）。
      await foreground() // 按键投给焦点窗口；没有前台就是按在别人的窗口上
      // `times` 缺席 = 一次。逐次之间留一点间隔：连按太快会被应用合并/丢弃（活体量过——
      // 一串 Tab 挤在一起只走了一格）。
      for (let n = 0; n < (step.times ?? 1); n++) {
        if (n > 0) await driver.sleep(PRESS_GAP_MS)
        await driver.press(step.key, deliver)
      }
    } else if (step.kind === 'clear') {
      // 收件人是此刻有焦点的输入框；语义与限制见 `DesktopStepKind` 里 `clear` 的头注。
      // 上一步多半刚点进输入框，焦点落定要一拍——组合键紧跟着点击发出去会赶在光标之前
      // （同 `press.times` 之间留间隔的理由：挤在一起的输入会被应用合并/丢弃）。
      await foreground()
      await driver.sleep(PRESS_GAP_MS)
      await driver.clearInput(deliver)
    } else if (step.kind === 'pickFile') {
      return pickFile(step, i)
    } else if (step.kind === 'wait') {
      await driver.sleep(step.ms)
    } else {
      // **认不出的 kind 判失败，不许走到 `return 'ok'`。** 落到这里只有两条路：本机
      // override 里手写的一条 grounding 拼错了 kind（那份文件只 `JSON.parse`，不过装载闸），
      // 或者 `kind:'branch'` 混进了 `groundings[]`（顶层的 branch 在候选之前就 `continue` 了，
      // 永远到不了这里）。两种都是"被选中、然后什么都不做"——而它此前会报成功、给
      // `verified.runs` 加一次，三次之后成为可贡献的落地方式。安静地成功比报错贵得多。
      return stepFailed(step, `不认识的步骤 kind：${String((step as { kind?: unknown }).kind)}`)
    }
    return 'ok'
  }

  if (!facts.platform) probe('agent 没报平台（老 agent）——只有通用落地方式参与')

  /** `branch` 跳过的终点（下标，不含）：小于它的步骤一律跳过。 */
  let skipUntil = 0
  /** 正在生效的那条 `branch` 的名字（进 `skipped` 的右半边）。 */
  let skippedBy = ''
  for (const [i, step] of recipe.steps.entries()) {
    // 第一步是 `window` 的 recipe：那一步跑完事实才学全，区域推迟到这里查表（见 `resolveAreas`）。
    // **「区域在任何输入之前解析完」仍然成立**：`window` 步骤只等窗口出现、一个输入都不发。
    if (i > 0 && !areasResolved) {
      const b = resolveAreas()
      if (b) return b
    }
    if (i < skipUntil) { probe(`#${i} ${step.kind} 被 branch 跳过`); skipped.push(`${step.label ?? `#${i}`} ← ${skippedBy}`); continue }
    probe(`#${i} ${step.kind}${step.label ? ` (${step.label.slice(0, 24)}…)` : ''}`)
    // 单步调试的闸（见 `opts.stepGate`）：停在这一步**之前**，什么都还没做。
    if (debug.stepGate) {
      const verdict = await debug.stepGate({ index: i, step, total: recipe.steps.length })
      if (verdict === 'abort') {
        return blocked('drift', `aborted-by-debugger@${stepKey(i, step)}：单步调试在这一步之前中止，此后不再发出任何输入`)
      }
    }
    // 条子上写"到第几步了"（见 `stepStatusText`：两行，参数只经 meta.purpose 上屏）。发在动作之前，
    // 用户看着指针滑过去的时候，条子上已经是这一步的名字。
    if (desktopStatusEnabled()) await driver.status(stepStatusText(recipe, params, i, step))
    // 分支只评一次，不做恒真检查、不调模型（同 require）；不成立就当没这一步。
    if (step.kind === 'branch') {
      // 参数分支不读屏：只看调用方给的参数（已经是字符串，见 `DesktopParamCondition`）。
      const ok = isParamCondition(step.when)
        ? params[step.when.param] === String(step.when.equals)
        : (await checkExpect(step.when, i, step)).ok
      if (ok) {
        skipUntil = i + 1 + step.skip
        skippedBy = step.label ?? `#${i}`
        probe(`#${i} branch 成立（${JSON.stringify(isParamCondition(step.when) ? step.when : (step.when.see ?? step.when.query))}）→ 跳过接下来 ${step.skip} 步${step.unverified ? `；这一趟标 unverified:${step.unverified}` : ''}`)
        // 成立 = 跳过了这一趟唯一的判据（见 `branch.unverified`）。记在回执上，"没验"不许长成"验过了"。
        if (step.unverified) unverified.push(step.unverified)
      }
      continue
    }
    // 守卫先于一切：`skipIf` 命中就整步跳过（见 `DesktopStepCommon`）。放在最前面是因为
    // 它要挡住的正是"这一步做了会有副作用"——幂等开关再点一次就是把它关掉。
    if (step.skipIf && (await find(subQuery(step.skipIf, params))).length > 0) continue
    last.hit = null // 自愈只作废**这一步**找到的那条模板，别背着上一步的命中
    // 这一步的候选落地方式：包内 `groundings` ∪ 本机 override ∪ 顶层通用 body（通用永远最后）。
    // 一条都没声明时 `candidates` 只有通用那一条，`active` 与 `step` 等价——老路径逐字不变。
    const local = step.label ? (debug.overrides?.groundingsFor(recipe.sourceId, step.label) ?? []) : []
    const candidates = rankGroundings(step as unknown as Record<string, unknown>, local, facts)
    /** 这一步有没有"并列的多份 body"可挑。没有就不记账、不加 `no-grounding@` 前缀——
     *  一条普通步骤的失败原因不该因为这个机制换个说法。 */
    const grounded = Boolean(step.label) && ((step.groundings?.length ?? 0) > 0 || local.length > 0)
    /** 这一步的 `else`（顶层键，换落地方式不会改它）。`'abort'` 要挡住**每一个**换候选的出口。 */
    const elseOf = (('else' in step ? step.else : undefined) ?? 'drift') as 'drift' | 'retry' | 'abort'
    let ci = 0
    let active: DesktopStep = effectiveStep(step as unknown as Record<string, unknown>, candidates[0]) as unknown as DesktopStep
    const tag = (g: RankedGrounding) => (g.universal ? 'universal' : `${g.source}:${g.on.platform ?? '*'}${g.on.app ? `@${g.on.app}` : ''}`)
    const tried: string[] = []
    if (candidates.length > 1) probe(`#${i} 候选落地方式 ${candidates.map(tag).join(' → ')}；先用 ${tag(candidates[0])}（${active.kind}）`)
    // 顶层写着一种动作、选中的落地方式换了另一种（`invoke` → `click`）时必须说出来：循环头那行
    // 探针报的是 `step.kind`，只看它会以为跑的是顶层那个动作。
    if (active.kind !== step.kind) probe(`#${i} 这一条落地方式的动作是 ${active.kind}，顶层写的是 ${step.kind}`)
    /**
     * 所有候选都没走通：drift 前缀 `no-grounding@<label>`，带上试过的清单与事实——这就是未来
     * 自动填充的接口（spec §7）。只有一条候选（纯通用）、或这一步压根没 label 时不加前缀，
     * 报的话和以前一样——`no-grounding@undefined` 既没信息又把原来那句有用的话挤掉了。
     */
    const noGrounding = (r: DesktopRunOutcome): DesktopRunOutcome =>
      !grounded || candidates.length <= 1
        ? r
        : { ...r, driftReason: `no-grounding@${step.label}：试过 ${tried.join('、')}；事实 ${JSON.stringify(facts)}；最后一条的原因：${r.driftReason}` }
    try {
      // 前置条件（`DesktopStepCommon.require`）：等它成立再动，等不到按 else 处理。**不做恒真
      // 检查**——"此刻必须为真"正是它的语义。判据不许调模型（同 expect）。
      if (active.require) {
        const req = await awaitExpect(active.require, i, step)
        if (!req.ok) {
          const else_ = ('else' in active ? active.else : undefined) ?? 'drift'
          const what = JSON.stringify(active.require.see ?? active.require.query)
          if (else_ === 'abort') {
            return blocked('drift', `aborted-by-recipe@${stepKey(i, step)}：前置条件未成立（${what}，等了 ${req.elapsed}ms），此后不再发出任何输入`)
          }
          return stepFailed(step, req.miss ? seeMiss('前置条件未成立', req.miss, `；等了 ${req.elapsed}ms`) : `前置条件未成立：${what}（等了 ${req.elapsed}ms）`)
        }
      }
      const ex = 'expect' in active ? active.expect : undefined
      // **动作之前先查一次**：此刻就成立的判据是装饰不是监督——它永远"通过"，于是这一步做没
      // 做成再也没人看。当场判 drift 并指名"恒真"，别等活体上真出问题那天才发现闸从来没有牙。
      // `fresh` 的判据换一种预检：不问"此刻成不成立"（它本来就可能成立），而是把此刻的位置记下来，
      // 动作后比的就是这张清单。没有这一帧，"新位置"就无从谈起。
      if (ex?.fresh && ex.see) {
        freshBaseline = (await seeResolver!.matches(groundSee(ex.see), { label: `${i}-fresh-before-${step.label ?? ''}` })) ?? []
      } else if (ex && (await checkExpect(ex, i, step)).ok) {
        return stepFailed(step, `expect 恒真：动作还没做它就已经成立（${JSON.stringify(ex.see ?? ex.query)}）——这不是判据，是装饰`)
      }
      let attempts = 0
      /** 每步最多消化一次。消化完还是不成立，就说明挡路的不是那个弹窗（或者关了又弹了一个）——
       *  再关一次只会把"点不动"变成"一直在点"，那时候真正该做的是把这一步判 drift 给人看。 */
      let dismissedThisStep = false
      /** 这一条落地方式没走通：还有下一条就换它重来（`attempts` 归零）；没有就把原因原样交出去。
       *  **每换一条都留痕**——退路做得越好，成功就越像成功，清单是事后唯一分得出"走的是哪条"的东西。 */
      const nextCandidate = (why: string): boolean => {
        tried.push(`${tag(candidates[ci])}（${why}）`)
        // **`else:'abort'` 挡住每一个换候选的出口。** 它的语义是"这一步没成，后面全都危险，
        // 此后一个输入都不发"——换一条落地方式重来正是在发输入，而且是在同一个已经失败的
        // 位置上。闸放在这里而不是各个出口上：出口有三个（动作失败 / 目标不在 / expect 未兑现），
        // 漏一个就等于 abort 在那条路上失效，而失效的样子和正常跑完一模一样。
        if (elseOf === 'abort') return false
        if (ci + 1 >= candidates.length) return false
        ci++
        active = effectiveStep(step as unknown as Record<string, unknown>, candidates[ci]) as unknown as DesktopStep
        attempts = 0
        probe(`#${i} 换落地方式 → ${tag(candidates[ci])}（${active.kind}）`)
        return true
      }
      /** 这一步是以"不用做"收场的（`optional` 的目标不在）。**不算走通**，不记账。 */
      let skipped = false
      for (;;) {
        const r = await runStep(active, i)
        if (r === 'skip') { if (nextCandidate('目标不在')) continue; skipped = true; break }
        if (r !== 'ok') {
          if (nextCandidate(r.driftReason ?? 'failed')) continue
          // 还有没试的候选、但 `else:'abort'` 不许试：这句话必须说出来，否则读的人会问
          // "为什么另外那条没跑"。单候选时一个字都不变（老路径）。
          if (elseOf === 'abort' && candidates.length > 1) {
            return blocked('drift', `aborted-by-recipe@${stepKey(i, step)}：这一条落地方式（${tag(candidates[ci])}）没走通（${r.driftReason}），else:abort 不许再试下一条，此后不再发出任何输入`)
          }
          return noGrounding(r)
        }
        // `focus` 步骤没有 expect（它的隐含判据就是"目标窗口在前台"），所以只对显式
        // `atFocus:true` 的条目才在这里无条件查一次：启动即弹的那张广告若不在这里关掉，会
        // 一直挡到下一步，而下一步的失败读起来像"界面变了"。**别的打断不查**——一次整窗读屏
        // 2–5 秒，没有条目 opt-in 时这里一次都不读（见 `DesktopInterrupt.atFocus` 头注）。
        // 查完不重验——这一步本来就没有可验的东西。
        const atFocusTable = interruptTable().filter((it) => it.atFocus)
        if (active.kind === 'focus' && !dismissedThisStep && atFocusTable.length > 0) {
          dismissedThisStep = await tryDismiss(i, step, atFocusTable)
        }
        if (!ex) break
        const missed = await awaitExpect(ex, i, step)
        if (missed.ok) break
        if (!dismissedThisStep && (await tryDismiss(i, step))) {
          dismissedThisStep = true
          if ((await awaitExpect(ex, i, step)).ok) break
        }
        const else_ = ('else' in active ? active.else : undefined) ?? 'drift'
        // **retry 走在自愈前面**：retry 的语义是"同一个动作原样再做一遍"，原样就包括用同一个
        // 靶子。第一次没兑现常常只是界面还没跟上（动画、网络），这时候删模板，重试那一趟就得
        // 重走模型段——一次白花的模型调用，换来的靶子多半还是刚才那个。
        if (else_ === 'retry' && attempts++ < 1) { probe(`#${i} expect 未兑现，retry 一次`); continue }
        // 这一条落地方式没兑现 → 换下一条（`abort` 由 `nextCandidate` 自己挡住）。介入闸留给
        // **最后一条**——前面几条只是"这台机器上不适用"，作废靶子、提一份修复提议都是无中生有。
        if (nextCandidate('expect 未兑现')) continue
        /**
         * 介入闸（spec §5）：**这一步彻底放弃了**，而它的靶子是**缓存给的**。三档都是同一个病：
         *
         * - `template`：上次模型指的那一刀冻下来的图，界面改版后照样能在别处匹配到高分；
         * - `point`：模型报的**坐标**，而坐标会漂（窗口挪一下、下次开机布局差一点）；
         * - `pinned`：上一趟固化下来的**控件名**，改版后那个名字可能挂到了别的控件上。
         *
         * 三者陈旧时的表现一模一样——**每趟都命中、每趟都点空**，而回执上写着一个看起来很稳的
         * `via`。唯一能戳破它的信号就是 `expect`：命中了却什么都没发生。
         *
         * **作废，但不在同一步里重走**：这一趟已经点过一次，副作用可能已经发生了，重来就是
         * 第二次点（发消息那条链路上，这是最贵的一种错）。作废是给**下一趟**的。
         *
         * `screen` / `a11y` 那两档不在此列：它们是**现读**的，没兑现说明界面上真的没有那个
         * 东西，不是靶子陈旧——对它们作废没有对象，提议也是无中生有。
         */
        const stale = lastHit()
        if (stale && (stale.via === 'template' || stale.via === 'point' || stale.via === 'pinned')) {
          seeResolver!.invalidate(stale)
          probe(`#${i} ${stale.via} 命中但 expect 未兑现，作废该靶子`)
          // 交出去当**提议**——不改 recipe（spec §5.3）：静默自愈会把「界面真的改了」和
          // 「这次没点中」混成同一件事，而后者自愈"成功"就等于把一个真 bug 每次都自动绕过去。
          // `see` 装的是**动作这一步**的目标，不是 `ex` 里那个——判据一格都不许被改写。
          // 现场（截图 + 元素表 + 文字）和提议一起交：人审和 AI 看的是同一张画面。
          // 每一项都独立 best-effort——**取证失败绝不许盖掉提议本身**，那会把「靶子陈旧」
          // 换成「取证为什么崩了」。
          let scene: Scene | undefined
          try {
            scene = await captureDesktopScene(driver)
          } catch {
            scene = undefined
          }
          await repairRunner.proposeLocator({
            sourceId: recipe.sourceId,
            ...(step.label ? { stepLabel: step.label } : {}),
            see: 'see' in active ? active.see : undefined,
            wasVia: stale.via,
            ...(stale.a11yRef ? { wasRef: stale.a11yRef } : {}),
            reason: `第 ${i} 步的 expect 未兑现，靶子已作废`,
            ...(facility ? { facility } : {}),
            ...(scene ? { scene } : {}),
          })
        }
        // abort = recipe 作者说"这一步没成，后面的动作全都危险"（发错人、点错按钮）。
        // 直接返回就是"此后一个输入都不发"——没有第二条路径能绕过这个 return。
        if (else_ === 'abort') {
          return blocked('drift', `aborted-by-recipe@${stepKey(i, step)}：expect 未兑现（${JSON.stringify(ex.see ?? ex.query)}），此后不再发出任何输入`)
        }
        // 报**真花掉的**时间，不是那个名义超时（见 `awaitExpect` 的头注）。轮数一并给出：
        // "等了 9000ms（3 轮）"一眼就看得出每轮读屏花了三秒，而名义值把这件事整个盖住。
        const waited = `等了 ${missed.elapsed}ms（${missed.rounds} 轮）`
        return noGrounding(stepFailed(active, missed.miss
          ? seeMiss('expect 未兑现', missed.miss, `；${waited}`)
          : `expect 未兑现：${JSON.stringify(ex.query)}（${waited}）`))
      }
      // 走出 `for (;;)` 且**真做成了**才记。`skip`（目标不在、这一步不用做）不算走通：
      // `verified.runs` 是贡献门槛的判据，把"没做"记成一次成功，攒够 3 次就会把一条从没验证过的
      // 落地方式推上游。
      if (grounded && !skipped) {
        used.push({
          label: step.label!,
          body: candidates[ci].body,
          on: candidates[ci].on,
          by: candidates[ci].verified?.by ?? (candidates[ci].source === 'local' ? 'ai' : 'author'),
        })
        usedTags[step.label!] = tag(candidates[ci])
      }
    } catch (e) {
      // 抬不到前台**不套这一步的 label**：那句 label 讲的是这一步自己的失败模式（"没等到
      // 窗口"），而这里窗口找到了、只是抬不上来——套上去就成了一句假话，而假话比没话更贵
      // （它会把排查引向"Chrome 是不是没装"）。抛出来那句本身已经指名道姓。
      if (e instanceof ForegroundRefused) return blocked('drift', e.message)
      // 同理不套 label：这句讲的是宿主没接线，不是这一步自己的失败模式。
      if (e instanceof SeeUnavailable) return blocked('drift', e.message)
      // 识别层读不了屏（见 `HARD_SEE_ERRORS`）：翻成这一步的 drift，好让 agent 那句人话
      // 进到 `driftReason` 里。**只认这几个前缀**，别的异常照抛——把未知的错吞成 drift，
      // 等于把一个我们还不认识的 bug 记成"界面变了"。
      if (HARD_SEE_ERRORS.some((p) => String((e as Error)?.message ?? '').startsWith(p))) {
        return stepFailed(step, `识别层读屏失败——${(e as Error).message}`)
      }
      throw e
    }
  }

  // Read the result subtree → items, dedupe by the stable id, optionally scroll-page to targetCount.
  // observer 的 itemQuery 同样要填参：一个界面上常常同时挂着好几组同 role 的列表（Telegram 的
  // 搜索结果和主消息列表都是 ListItem），把当次的参数（频道名 / 搜索词）编进查询，是唯一能
  // 区分"我要读哪一组"的手段。
  // 动作型 recipe 整个省掉 observer（见 `DesktopRecipe.observer`）：无物可读，一次 read 都不发。
  // **`allowEmpty` 是硬条件**——省了 observer 又没开它，等于宣称"我会读到东西"却根本没读，
  // 那必须是 drift 而不是一个安静的 ok。
  if (!recipe.observer || !recipe.read) {
    if (!recipe.allowEmpty) return blocked('drift', 'recipe has no observer but allowEmpty is off')
    flushAreaUse()
    debug.overrides?.recordRun(recipe.sourceId, used, facts, debug.packageInfo)
    return { outcome: 'ok', items: [], driftReason: null, ...(typedVia ? { typedVia } : {}), ...(Object.keys(seeVia).length ? { seeVia } : {}), ...(dismissed.length ? { dismissed } : {}), ...(Object.keys(usedTags).length ? { groundings: usedTags } : {}), ...(Object.keys(areaTags).length ? { areas: areaTags } : {}), ...(skipped.length ? { skipped } : {}), ...(unverified.length ? { unverified } : {}), ...(Object.keys(pickFiles).length ? { pickFile: pickFiles } : {}) }
  }
  const observer = { ...recipe.observer, itemQuery: subQuery(recipe.observer.itemQuery, params) }
  const { dedupeBy, targetCount, scroll } = recipe.read
  const seen = new Set<string>()
  const items: Record<string, string>[] = []
  const maxTicks = scroll?.maxTicks ?? 0

  for (let tick = 0; ; tick++) {
    // map 在 dedupe **之前**跑：`read.dedupeBy` 可以指向抽出来的字段（如 link），而按整段正文
    // 去重是不稳的——正文尾巴上挂着浏览数、"已编辑"这类每次读都在变的东西。
    const batch = (await driver.readSubtree(observer)).map((it) => applyMap(it, recipe.map))
    let fresh = 0
    for (const it of batch) {
      const id = it[dedupeBy]
      if (id == null || seen.has(id)) continue
      seen.add(id)
      items.push(it)
      fresh++
      if (items.length >= targetCount) break
    }
    if (items.length >= targetCount) break
    // single-read (no scroll) or exhausted ticks → done; a dry scroll (no fresh items) = at the end
    if (!scroll || tick >= maxTicks || fresh === 0) break
    await driver.scroll(scroll.dir, scroll.amount)
    await driver.sleep(400) // let the list re-render before the next read
  }

  // 0 条默认判 drift；`allowEmpty` 开着时，0 条是动作型 recipe 唯一合法的成功形状（见
  // `DesktopRecipe.allowEmpty` 的注释）——这个开关只改变这一步的判法，不影响上面任何其它
  // 失败路径（登录墙、invoke 定位不到目标都照样判各自的结果）。
  if (items.length === 0 && !recipe.allowEmpty) return blocked('drift', 'no items read')
  // **只有整趟走到这里才记账**：中途 drift 的那一趟里，"这条落地方式管用"根本没被证实
  // （后面几步没跑过），记下去等于把一次失败算成一次成功，而 `verified.runs` 正是贡献门槛的判据。
  flushAreaUse()
  debug.overrides?.recordRun(recipe.sourceId, used, facts, debug.packageInfo)
  return { outcome: 'ok', items, driftReason: null, ...(typedVia ? { typedVia } : {}), ...(Object.keys(seeVia).length ? { seeVia } : {}), ...(dismissed.length ? { dismissed } : {}), ...(Object.keys(usedTags).length ? { groundings: usedTags } : {}), ...(Object.keys(areaTags).length ? { areas: areaTags } : {}), ...(skipped.length ? { skipped } : {}), ...(unverified.length ? { unverified } : {}), ...(Object.keys(pickFiles).length ? { pickFile: pickFiles } : {}) }
}
