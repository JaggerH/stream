/**
 * DesktopDriver — the `a11y`-vocabulary driver for the `host-desktop` Engine.
 *
 * It is the desktop counterpart of the browser `PageDriver`, but it speaks the OS
 * accessibility tree (role / name / native class hint / invoke), NOT DOM selectors —
 * so it is a SEPARATE interface, not an implementation of `PageDriver` (see
 * `docs/superpowers/specs/2026-07-19-desktop-uia-engine-telegram-design.md` §2.2,
 * the http/html precedent). Every method delegates over a thin `HostRelay` to a
 * cross-platform native process of Stream Desktop (Rust: enigo for input + a per-OS `A11yBackend` —
 * Windows UIA / macOS AX / Linux AT-SPI). The recipe logic stays on the backend,
 * mirroring the ext-cdp transport split. Each method is ONE relay round-trip
 * (coarse-grained ops; the agent walks the a11y tree locally), so a locate/read
 * never becomes thousands of per-node RPCs.
 *
 * Everything here is platform-NEUTRAL: `role`/`name`/`rect`/`invoke` map to UIA
 * (ControlType/Name/Invoke), AX (AXRole/AXTitle/AXPress), and AT-SPI (role/name/
 * action) alike. `className` is an OPTIONAL per-platform locator hint. This module
 * is the backend contract that PINS the wire protocol every Stream Desktop build implements.
 */

/** One request to Stream Desktop's native process. `op` names the primitive; `args` is its JSON payload. */
export interface HostOp {
  op: string
  args?: Record<string, unknown>
}

/**
 * The narrow relay to Stream Desktop (mirrors ext-cdp's `RawPageRelay` — kept small
 * so a fake stays trivial in tests). `send` performs one request/response round-trip.
 */
export interface HostRelay {
  send(op: HostOp): Promise<unknown>
  /** 可选的会话租约（`WsHostRelay.withSession` 的实现）：把 `fn` 整体当一个不可分割的
   *  单元跑，持有期间别人的 `send()` 排队等释放——这是防"两条并发桌面 recipe 的 op 交错"
   *  的那道闸（见 `host-relay.ts` 头注）。测试用的假 relay 可以不实现——`runDesktopRecipe`
   *  在它缺席时直接跑，不做跨调用互斥（单个测试里从来没有第二条并发 recipe 要防）。
   *  `opts.waitMs`：排队等释放的等待上界覆盖（见 `INTERACTIVE_SESSION_WAIT_MS` 头注）。 */
  withSession?<T>(fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T>
}

/** A screen rectangle in physical pixels — the common denominator every Engine can act on. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A located accessibility element: its screen rect (for coordinate actuation) plus an
 * opaque `ref` (the handle fast-path — `invoke(ref)` triggers the element's native
 * action without computing a coordinate). Mirrors ENGINE.md's `{rect, handle?}`
 * contract: `rect` is always present; `ref` is the handle.
 */
export interface A11yElement {
  ref: string
  /** neutral role — UIA ControlType / AX AXRole / AT-SPI role (e.g. "Button", "List") */
  role: string
  /** accessible name / label — UIA Name / AX AXTitle / AT-SPI name */
  name: string
  /** OPTIONAL per-platform locator hint (Windows/Qt widget class); "" when the backend has none */
  className: string
  rect: Rect
}

/**
 * A locate query in the `a11y` vocabulary — platform-neutral. Core keys are `role`
 * and `name`; `className` is an OPTIONAL per-platform hint (on Windows/Qt it is the
 * compiled widget class, e.g. Telegram's `HistoryInner`, load-bearing where UIA
 * AutomationId is absent; macOS AX / Linux AT-SPI backends may ignore it and lean on
 * role+name+identifier). A portable recipe keys on role+name.
 */
export interface A11yQuery {
  role?: string
  /** 全等匹配（大小写敏感）。 */
  name?: string
  /**
   * 名字**包含**这一段就算命中（大小写不敏感）。与 `name` 互斥——两个都给，agent 直接报错。
   *
   * **列表项这类控件的 name 常常是一整句动态拼出来的**（Telegram 的会话列表项：
   * 「频道, <名字>, 已静音, 1908 个新消息, <最后一条消息>, 1:39」），未读数和预览每秒都在变，
   * 全等匹配**永远**匹配不上；而失败的样子是**空结果**，与"这个元素不存在"一模一样，
   * 最容易被误判成"这个界面读不到"。名字里稳定的那截用这一位匹配。
   */
  nameContains?: string
  className?: string
  /** structural path from the window root; each segment is a partial match, outermost first */
  path?: Array<{ role?: string; name?: string; className?: string }>
}

/**
 * 一次 `find` 的结果——**不是裸数组**，因为空结果必须能自证是哪一种空。
 *
 * `unbuilt` 在场 = agent 说「0 命中，而搜索范围限定的那个窗口此刻不在前台」。**它说的只是
 * "这个空不可采信"，不解释为什么**——原因在应用侧，而且各不相同：有的应用树是懒建的、要
 * 激活才长出来，有的（QQ NT 这种 Electron）**压根不暴露**，激活也没有。
 *
 * **别把锁屏或"不在前台"当原因。** 同一时刻、同样锁屏、同样不在前台的实测（本机 2026-09-07）：
 * `chrome.exe` 读到 238 个控件（连页面内容节点都在），`explorer.exe` 4 个，而 `QQ.exe` 只有
 * 8 个满窗大小、无名的 `Pane`。UIA 在锁屏下照常工作——挡住的是**投键鼠**，不是读。
 *
 * 能改的是别让「确实没有」和「根本没读到」长成同一个形状——调用方要能**不看日志**就分得开
 * （判据与三个前提见 host-agent 的 `empty_may_be_unbuilt`；那里也给了分辨的动作：同一时刻
 * 读一下别的应用）。
 *
 * 它是**提示不是判决**，也刻意不是错误：`find` 读空是后台采集的常态（找不到登录墙 = 没被墙住），
 * 做成错误等于把所有"不抢用户屏"的 recipe 一刀切死。字段缺席 = 没有这个信号，**不是**"验过了"。
 */
export interface A11yFindResult {
  elements: A11yElement[]
  /** agent 给的那句人话（前缀 `a11y-unbuilt:`）；没挂旗时**没有这个字段**。 */
  unbuilt?: string
}

/** How to read one field off an item element (the item itself, or a descendant match). */
export interface A11yFieldSpec {
  /** read from a descendant matching this sub-query; omit to read the item element itself */
  from?: A11yQuery
  /** which accessibility text property carries the value (UIA Name/Value, AX AXTitle/AXValue, …) */
  read: 'name' | 'value'
}

/** How to read a subtree into items (the `a11y` Observer): match items, map fields, dedupe. */
export interface ReadSpec {
  /** matches each item element (e.g. role "ListItem" under the message list) */
  itemQuery: A11yQuery
  /** target field name → how to read it from an item */
  fields: Record<string, A11yFieldSpec>
  /** which field holds the stable per-item id used for dedupe */
  dedupeBy: string
}

/** Which app/window to focus (the desktop analogue of the browser Engine's `goto`). */
export interface AppMatch {
  process?: string
  windowClass?: string
  /** 窗口标题，**包含**匹配（不是全等——真实标题带动态前后缀，全等在活体上几乎必然落空）。
   *  一个进程开多个窗口时这是唯一的消歧维度；没有它，调用方只能靠关掉其他窗口。 */
  title?: string
}

/** 一个可寻址的原生窗口。字段选得足以直接拼出 `app:<process>/<title>` 地址——
 *  枚举的用途就是"认出目标再动手"，一份认不出目标的清单等于没有。 */
export interface WindowInfo {
  id: string
  process: string
  title: string
  foreground: boolean
  /** agent 跑在哪个平台上（由 agent 报——后端可能在 WSL、agent 在 Windows）。老 agent 不报。 */
  platform?: 'win32' | 'darwin'
  /** 这个窗口所属应用的版本；读不到就缺席（老 agent 一律缺席）。 */
  appVersion?: string
}

/** 动作**之后**的回读判据（a11y 词汇下的 `expect`，对应浏览器侧 `cdp_act` 的选择器）。 */
export interface DesktopExpect {
  role?: string
  name?: string
  className?: string
}

/** 一次 actuation 的结果。
 *
 *  `via` = 这一下**走的哪条路**：`invoke` 是元素句柄直达（不算坐标、不受遮挡影响、不需要
 *  前台，锁屏也生效），`coords` 是投给屏幕坐标（必须前台确权）。同一个 `cdp_act` click 底下
 *  "有 ref 走 invoke / 没 ref 走坐标"是个调用方看不见的分支，而锁屏时行不行恰恰取决于它——
 *  不报出来，调用方解释不了自己拿到的结果。
 *
 *  `confirmed` 三态：`true` 验过且兑现 / `false` 验过但没兑现（acted-unconfirmed）/
 *  `undefined` **没验**。第三态必须留着——没给 `expect` 却报 `confirmed:true` 是在撒谎，
 *  而这正是这条链路上最贵的一类错误（一个恒 true 的 focusApp 曾让整晚三次实验的结论全建在
 *  流沙上）。 */
export interface ActOutcome {
  via?: 'invoke' | 'coords' | 'value' | 'message'
  confirmed?: boolean
}

/**
 * 坐标类输入（click / type / press / scroll）投给谁。省略 = 投给屏幕（agent 用 enigo 合成输入，
 * 必须先把目标窗口抢到前台，锁屏时被拒）；`'message'` = 投给 scope 到的那个窗口
 * （`PostMessage` 到它的 hwnd）——**有收件人**，所以和 `invoke`/`setValue` 一样不抢前台、锁屏照常。
 *
 * 它不是自动退路，是 recipe 显式声明的（`DesktopRecipe.input`）：走自己合成器的 Electron 多半
 * 不理会投进来的消息，而且失败得安静。哪个应用认它只能真机量（微信 4.x 认，2026-09-07 锁屏全程验过）。
 */
export type InputDelivery = 'message'

/** `screenshot` op 的完整回执：整窗 JPEG + 窗口屏幕物理 rect + 该窗口缩放比（DPI/96）。
 *  `scale` 是**诊断字段**：缓存键用的是读屏那一次的 scale，这里只为让两次抓拍可对账。 */
export interface WindowCapture { jpeg: Buffer; window: Rect; scale: number }

/** 文字表里的一段。`rect` 是**截图上的物理坐标**（相对窗口左上角）。 */
export interface ScreenText { text: string; rect: Rect }
/**
 * `readText` op 的回执 —— **画面上写了什么**，判据与读内容查它。
 *
 * `window` 是窗口在屏幕上的物理 rect：`rect + window` 就是屏幕物理坐标，中间没有第三套坐标系。
 * **给了 `region` 也照样是整窗那个 rect**（agent 把裁剪原点加回去了），所以 `toScreen` 不用分档。
 */
export interface TextRead {
  texts: ScreenText[]
  window: Rect
  scale: number
}

/** 元素这一条是哪一档来源给的（可信度递减：a11y > detector > text）。 */
export type SeeElementKind = 'a11y' | 'detector' | 'text'
/**
 * 元素表里的一条 —— **哪儿能点、点的是什么**，动作查它。
 *
 * 和 `ScreenText` 是两个问题：同一个按钮在两张表里的框不一样，文字框只圈住那几个字，元素框
 * 才是整个可点区域。`name` **可能不存在**（只有图标的按钮）——按名匹配时无名的必须出局，
 * 别把它补成空串：`squash(name).includes(want)` 在空串上恒真，包含匹配会静默命中每一个无名图标。
 */
export interface SeeElement { rect: Rect; name?: string; kind: SeeElementKind }
/** `readElements` op 的回执。`window` / `scale` 同 `TextRead`，理由一样。 */
export interface ElementsRead {
  elements: SeeElement[]
  window: Rect
  scale: number
}
export interface ImageHit { rect: Rect; score: number }

/**
 * The `a11y`-vocabulary driver. Actuation primitives (`click`/`moveMouse`/`scroll`/
 * `type`/`focusApp`) are vocabulary-agnostic Engine ops; `find`/`invoke`/`readSubtree`
 * are the `a11y` Locator/Observer. `url` reports the foreground window id from the OS
 * window manager (never from the controlled app — "trust the engine, not the surface").
 */
export interface DesktopDriver {
  focusApp(match: AppMatch): Promise<boolean>
  /** 列出可寻址的顶层窗口。**先认出目标再动手**——多窗口时这是唯一的消歧依据。 */
  windows(): Promise<WindowInfo[]>
  /** 只把后续 `find`/`readSubtree` 的范围限定到某个窗口，**不碰焦点、不动 Z 序**。
   *  读和动手是两件事：看一眼不该把用户的窗口拽到前面来；而范围又不能不限，不限就是在整个
   *  桌面上搜、别的窗口的元素会漏进结果。 */
  scopeWindow(match: AppMatch): Promise<WindowInfo>
  /** 命中的元素 + 「这次空结果可能是没读到」的那面旗（见 `A11yFindResult`）。 */
  find(query: A11yQuery): Promise<A11yFindResult>
  invoke(ref: string, expect?: DesktopExpect): Promise<ActOutcome>
  /**
   * 把一段文字**写进某个元素**（UIA ValuePattern 一类），不经键盘。
   *
   * 和 `type` 的区别就是这条路存在的理由：键盘投给"此刻的焦点窗口"，所以必须先抢屏；
   * 这里的收件人是元素句柄，因此**不需要前台**（同 `invoke`）。定时采集靠它才能整轮不碰
   * 用户的屏幕。不是所有控件都认——失败是常态之一，调用方要准备好退回键盘并留痕。
   */
  setValue(ref: string, text: string, expect?: DesktopExpect): Promise<ActOutcome>
  /** 末尾的 `deliver` 四个坐标 op 同义：见 `InputDelivery`。 */
  click(rect: Rect, button?: 'left' | 'right' | 'middle', expect?: DesktopExpect, deliver?: InputDelivery): Promise<ActOutcome>
  moveMouse(x: number, y: number): Promise<ActOutcome>
  /**
   * 发一次**零位移**的真实输入，把挂起的渲染端叫醒——**指针一动不动**。
   *
   * `PostMessage` 不是"用户输入"：不重置系统空闲计时器、不让 Chromium 把窗口从 occluded 里
   * 放出来。机器闲下来（不必锁屏）渲染端一挂起，投进去的点击与按键就**整份被静默丢弃**，
   * 而 `PostMessage` 照样返回成功、截图照样出图——三处都不喊。
   *
   * 回 `false` = 这个 agent 没有这一口（老 agent / 非 Windows），调用方自己落到
   * `moveMouse` 那条退路上（能叫醒，但会把用户的指针挪走）。**别把缺席补成成功**：
   * 那会让"叫醒了"和"根本没叫"长成同一个样子，而这条链路上正是这种同形最贵。
   */
  nudge(): Promise<boolean>
  /**
   * 往接管指示条上写"现在在做什么"（两行、`\n` 连：`微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)`，形状归 runner 的 `stepStatusText`）；`null` = 清掉。
   *
   * 它**不点亮**条子（agent 侧归 QUIET）——只有真动键鼠才亮，这句话是亮起来之后副句里
   * 多出来的那一段。老 agent 不认这个 op → 静默吞掉（提示缺席不该让那一步失败）；其它错误照抛。
   * **参数值只经 `meta.purpose` 上屏**（作者点名要露的那一个，如「发给 文件传输助手」）：
   * 正文与步骤 label 里的 `{x}` 模板一律原样留着不替换，别的参数不该出现在谁路过都看得见的地方。
   */
  status(text: string | null): Promise<void>
  scroll(dir: 'up' | 'down', amount: number, expect?: DesktopExpect, deliver?: InputDelivery): Promise<ActOutcome>
  type(text: string, expect?: DesktopExpect, deliver?: InputDelivery): Promise<ActOutcome>
  readSubtree(spec: ReadSpec): Promise<Record<string, string>[]>
  screenshot(): Promise<Buffer | null>
  /** 整窗截图 + 窗口 rect + 缩放比。老 agent（回执没有 `window`）→ null。 */
  captureWindow(): Promise<WindowCapture | null>
  /**
   * 读**文字表**（画面上写了什么）。`region` 是截图坐标系的一块，缺省 = 整窗；它是**下推**给
   * agent 的裁剪窗口，不是取回来之后的过滤器——整窗一次 PP-OCR 约 0.8s（Windows）/ 0.9s（mac）
   * （数字见 `docs/research/ocr-engine-benchmark.md` §2），本地过滤的结果一模一样，只是每步
   * 慢那么多，而这件事不会出现在任何断言里。
   *
   * agent 不支持（老 agent / 非 Windows）→ null，不抛。`bad-region:` / `ort-missing:` 这类
   * **硬失败照抛**（见 runner 的 `HARD_SEE_ERRORS`）：把"这台机器读不了屏"吞成"没找到"，
   * 表现是每一步都轮询到超时，而唯一说得清怎么办的那句话一次都不会被人看见。
   */
  readText(region?: Rect): Promise<TextRead | null>
  /**
   * 读**元素表**（哪儿能点、点的是什么）。`region` 同 `readText`。
   *
   * `icons` 才跑检测器（OmniParser icon_detect，约 2 秒），缺省 false：只有"没有文字可指"的
   * 目标才需要它，每步都带上就是给稳态回放每步白付两秒。
   *
   * `a11y` 缺省 true；`false` = recipe 作者申报了"这个应用没有控件树"（`RecipeAppMatch.a11y`），
   * agent 跳过控件树枚举。**方向和 `icons` 相反**（缺省开），因为缺席被当成关就是所有有控件树的
   * 应用静默失去 a11y 那一档。老 agent 不认这个参数会照旧枚举——只是慢，不是错。
   */
  readElements(opts?: { region?: Rect; icons?: boolean; a11y?: boolean }): Promise<ElementsRead | null>
  /** 拿一张模板 PNG 在窗口截图上找位置。没找到 → null；agent 不支持 → null。
   *  `region`（截图坐标）：只在这一块里找，回的框仍是整窗截图坐标——逐像素扫整窗一次 2s，
   *  给了 region 就别扫整窗。老 agent 不认这个参数会照旧扫整窗，调用方的 `inRegion` 仍然把关。 */
  findImage(templatePng: Buffer, region?: Rect): Promise<ImageHit | null>
  /** 单个按键（Escape / Enter）。坐标类输入：agent 侧过前台闸门（`deliver:'message'` 时不过）。 */
  /** 单个按键。放行哪些键由 recipe 装载期那条判据管（`PRESSABLE_KEYS`：只放行改变状态、
   *  不 actuate 的键）——driver 这一层不再收窄，`Enter` 仍在类型里是因为 `interrupts` 的
   *  `dismiss` 走的是另一条路。坐标类输入：agent 侧过前台闸门（`deliver:'message'` 时不过）。 */
  press(key: 'Escape' | 'Enter' | 'Tab', deliver?: InputDelivery): Promise<ActOutcome>
  /** 清空此刻有焦点的输入框（全选 + 删除，修饰键归平台后端）。只走抢屏路：agent 对
   *  `deliver:'message'` 直接拒（组合键投不进后台窗口），老 agent 不认这个 op 也照抛——
   *  "以为清了、其实没清"会让上一轮的草稿接在这一轮正文后面一起发出去。 */
  clearInput(deliver?: InputDelivery): Promise<ActOutcome>
  url(): Promise<string>
  /** host-side dwell (e.g. let a scrolled list re-render before re-reading) */
  sleep(ms: number): Promise<void>
  /**
   * 确保某个应用在跑——**不在跑就启动，已经在跑就什么都不做**。
   *
   * **和 `focusApp` 是两件事，别混。** `focusApp` 会 SetForegroundWindow + BringWindowToTop，
   * 还专门绕过 Windows 前台锁——它的职责就是**抢屏**。这个的语义只是「让进程活着」：Z 序、
   * 焦点、最小化状态一律不动。采集迁到用户 Chrome 之后，唤醒浏览器是常规动作，要是顺手用了
   * focusApp，每次定时采集都会把用户的屏幕抢过去。
   */
  ensureApp(spec: EnsureAppSpec): Promise<EnsureAppOutcome>
  /** 转发底层 relay 的会话租约（若 relay 提供）——见 `HostRelay.withSession` 头注。
   *  `runDesktopRecipe` 靠这个字段的有无判断"这个 driver 背后的 relay 支持不支持整趟串行化"。 */
  withSession?<T>(fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T>
}

/** 见 host-agent 的 `LaunchSpec`。字段全可选：全省略 = 按默认路径拉起 Chrome 的默认 profile。 */
export interface EnsureAppSpec {
  exe?: string
  /** Chrome 的 `--profile-directory`（`Default` / `Profile 1`）——**不是 `--user-data-dir`**：
   *  后者会另开一份空的 user data，没有登录态、没有扩展，等于把刚搬过来的东西又搬走。 */
  profileDirectory?: string
  args?: string[]
  process?: string
  /** 即使进程已经在跑也再启动一次。**只在调用方已确认它不答话时才传** ——「进程活着」不等于
   *  「能用」（托盘里的 Chrome：进程在、没窗口、SW 睡着），再 spawn 一次会让 Chrome 把调用
   *  交给已有实例并开一个窗口，SW 随之醒来。无条件传等于每轮采集都弹窗。 */
  force?: boolean
}

export interface EnsureAppOutcome {
  /** 调用返回时它到底在不在跑（**回读出来的**，不是"我发了启动命令"）。 */
  running: boolean
  /** 这次是不是我们启动的（false = 本来就在跑）。 */
  started: boolean
  pid?: number
  process: string
  /** 这次**开出来的那个窗口**（拿得准的时候才有）。
   *
   *  「打开 → 拿到窗口 → find/invoke」要成为一条不断的链，每一步都得有判据。只报 pid 的话
   *  下一步只能猜标题，而窗口标题带动态前后缀，猜出来的 `app:<process>/<title>` 地址十有八九
   *  指不中。拿不准（一个都没开出来、或几个都像）时**没有这个字段**——指错一个比不给更坏。 */
  window?: WindowInfo
}

/** 老版本对新 op 回 `unknown op: …`，非 Windows 后端回 `host agent: … only implemented for Windows`——
 *  两种都是"这台没有这个能力"，调用方据此让梯子落下一段，而不是把整趟 recipe 炸掉。
 *
 *  **那句 `host agent:` 是 Rust 侧原样发过来的**（`app/host-agent/src/main.rs` 的
 *  `#[cfg(not(windows))]`），不是我们这边的文案：产品叫 Stream Desktop，但这是线上的线格式，
 *  改这边的字面量只会让匹配失效。 */
function isUnsupportedOp(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /unknown op|only implemented for Windows|unsupported/i.test(m)
}

/**
 * Build a DesktopDriver over one relay. This is the single place that knows the wire
 * shape of each op and how a reply is unwrapped — Stream Desktop's Rust process implements the
 * matching op handlers.
 */
export function makeDesktopDriver(raw: HostRelay): DesktopDriver {
  /**
   * **每一次 op 的往返耗时**，挂在已有的 `STREAM_DESKTOP_SEE_TRACE` 这一个开关下（不另立旋钮）。
   *
   * 没有它就没法回答"这一趟为什么要三十秒"：上层日志只有步与步的边界，而一步里可能有
   * 截图 + 识别 + 模板三次往返，谁贵看不出来——只能靠猜，而猜过的两次都猜错了（先怪模型、
   * 再怪焦点）。**一条 op 一行，别在这里做聚合**：聚合要先假设哪些维度重要，而这正是还不知道的事。
   */
  const relay: HostRelay = process.env.STREAM_DESKTOP_SEE_TRACE
    ? {
        async send(op) {
          const t0 = Date.now()
          try {
            return await raw.send(op)
          } finally {
            console.log(`[desktop-op] ${op.op} ${Date.now() - t0}ms`)
          }
        },
        ...(raw.withSession ? { withSession: raw.withSession.bind(raw) } : {}),
      }
    : raw
  /** agent 回的是 `{via}` 或 `{via, confirmed:bool}`——原样透传，**不把缺失补成 true**。
   *  `via` 也一样只认 agent 说的：猜一个"大概走了 invoke"就把这个字段的全部价值抹掉了。 */
  const outcome = (v: unknown): ActOutcome => {
    const raw = v as { confirmed?: unknown; via?: unknown } | undefined
    const c = raw?.confirmed
    const via =
      raw?.via === 'invoke' || raw?.via === 'coords' || raw?.via === 'value' || raw?.via === 'message' ? raw.via : undefined
    return { ...(via ? { via } : {}), ...(typeof c === 'boolean' ? { confirmed: c } : {}) }
  }
  return {
    async focusApp(match) {
      const r = (await relay.send({ op: 'focusApp', args: { match } })) as { ok?: boolean } | boolean
      return typeof r === 'boolean' ? r : r?.ok === true
    },
    async windows() {
      return ((await relay.send({ op: 'windows' })) as WindowInfo[]) ?? []
    },
    async scopeWindow(match) {
      const r = (await relay.send({ op: 'scopeWindow', args: { match } })) as { window: WindowInfo }
      return r.window
    },
    async ensureApp(spec) {
      // 整个 spec 就是 args（host-agent 侧的 LaunchSpec 同形），字段全可选
      return (await relay.send({ op: 'ensureApp', args: { ...spec } })) as EnsureAppOutcome
    },
    // agent 回 `{elements, unbuilt?}`。**老 agent 回的是裸数组**——照收，但不凭空造出
    // `unbuilt`：那一档是"没验到"，谎报成"验过了、结果是空"正是这次要消灭的东西。
    async find(query) {
      const r = await relay.send({ op: 'find', args: { query } })
      if (Array.isArray(r)) return { elements: r as A11yElement[] }
      const raw = r as { elements?: A11yElement[]; unbuilt?: unknown } | undefined
      const unbuilt = typeof raw?.unbuilt === 'string' ? raw.unbuilt : undefined
      return { elements: raw?.elements ?? [], ...(unbuilt ? { unbuilt } : {}) }
    },
    async invoke(ref, expect) {
      return outcome(await relay.send({ op: 'invoke', args: { ref, ...(expect ? { expect } : {}) } }))
    },
    async setValue(ref, text, expect) {
      return outcome(await relay.send({ op: 'setValue', args: { ref, text, ...(expect ? { expect } : {}) } }))
    },
    async click(rect, button = 'left', expect, deliver) {
      return outcome(await relay.send({ op: 'click', args: { rect, button, ...(expect ? { expect } : {}), ...(deliver ? { deliver } : {}) } }))
    },
    async moveMouse(x, y) {
      return outcome(await relay.send({ op: 'moveMouse', args: { x, y } }))
    },
    async nudge() {
      try {
        await relay.send({ op: 'nudge' })
        return true
      } catch (e) {
        // 老 agent 不认这个 op → 落退路。**其它错误照抛**：`nudge-refused`（锁屏时
        // SendInput 被系统拒）不是"没有这个能力"，吞掉它就等于把"叫不醒"说成"叫醒了"。
        if (isUnsupportedOp(e)) return false
        throw e
      }
    },
    async status(text) {
      try {
        await relay.send({ op: 'status', args: { text } })
      } catch (e) {
        // 老 agent 不认这个 op → 吞掉：条子上少一句话不该让这一步失败。**其它错误照抛**
        // （WS 断了之类），那是整趟都要停的病，不是"没有这个能力"。
        if (isUnsupportedOp(e)) return
        throw e
      }
    },
    async scroll(dir, amount, expect, deliver) {
      return outcome(await relay.send({ op: 'scroll', args: { dir, amount, ...(expect ? { expect } : {}), ...(deliver ? { deliver } : {}) } }))
    },
    async type(text, expect, deliver) {
      return outcome(await relay.send({ op: 'type', args: { text, ...(expect ? { expect } : {}), ...(deliver ? { deliver } : {}) } }))
    },
    async readSubtree(spec) {
      return ((await relay.send({ op: 'readSubtree', args: { spec } })) as Record<string, string>[]) ?? []
    },
    async screenshot() {
      const res = (await relay.send({ op: 'screenshot' })) as { base64?: string } | undefined
      return res?.base64 ? Buffer.from(res.base64, 'base64') : null
    },
    async captureWindow() {
      const res = (await relay.send({ op: 'screenshot' })) as { base64?: string; window?: Rect; scale?: number } | undefined
      if (!res?.base64 || !res.window) return null
      return { jpeg: Buffer.from(res.base64, 'base64'), window: res.window, scale: typeof res.scale === 'number' ? res.scale : 1 }
    },
    async readText(region) {
      try {
        const r = (await relay.send({ op: 'readText', args: { ...(region ? { region } : {}) } })) as TextRead | undefined
        return r && r.window ? { texts: r.texts ?? [], window: r.window, scale: r.scale ?? 1 } : null
      } catch (e) {
        if (isUnsupportedOp(e)) return null
        throw e
      }
    },
    async readElements(opts) {
      try {
        const args = {
          ...(opts?.region ? { region: opts.region } : {}),
          icons: opts?.icons === true,
          // runner 恒给这一格（`recipe.app.a11y ?? true`，见 desktop-runner.ts）；直接调 driver
          // 的调用方（不经 runner）不给时，就让 agent 按它自己的缺省（true）走。
          ...(opts?.a11y !== undefined ? { a11y: opts.a11y } : {}),
        }
        const r = (await relay.send({ op: 'readElements', args })) as ElementsRead | undefined
        if (!r?.window) return null
        return {
          // **空名当作没名字**：agent 缺席时就不发这一格，但一个补成 `""` 的实现（或将来某个
          // 别的 agent）会让上层的包含匹配命中每一个无名图标——见 `SeeElement.name`。
          elements: (r.elements ?? []).map((e) => ({ rect: e.rect, kind: e.kind, ...(e.name ? { name: e.name } : {}) })),
          window: r.window,
          scale: r.scale ?? 1,
        }
      } catch (e) {
        if (isUnsupportedOp(e)) return null
        throw e
      }
    },
    async findImage(templatePng, region) {
      try {
        const r = (await relay.send({ op: 'findImage', args: { template: templatePng.toString('base64'), ...(region ? { region } : {}) } })) as Partial<ImageHit> | undefined
        return r?.rect && typeof r.score === 'number' ? { rect: r.rect, score: r.score } : null
      } catch (e) {
        if (isUnsupportedOp(e)) return null
        throw e
      }
    },
    async press(key, deliver) {
      return outcome(await relay.send({ op: 'press', args: { key, ...(deliver ? { deliver } : {}) } }))
    },
    async clearInput(deliver) {
      return outcome(await relay.send({ op: 'clearInput', args: { ...(deliver ? { deliver } : {}) } }))
    },
    async url() {
      return ((await relay.send({ op: 'url' })) as string) ?? ''
    },
    async sleep(ms) {
      await relay.send({ op: 'sleep', args: { ms } })
    },
    // relay 没提供 withSession 就不挂这个字段（而不是挂一个"什么都不做"的假实现）——
    // `runDesktopRecipe` 靠字段的有无分支，一个恒存在但空转的实现会让它误以为已经串行化了。
    ...(relay.withSession ? { withSession: relay.withSession.bind(relay) } : {}),
  }
}
