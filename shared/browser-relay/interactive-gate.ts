/**
 * 交互 lane 的两档模式与高危确认门（CP3）。
 *
 * 用户拍板的规则：**默认 `act-without-asking`** —— AI 自主往前走，只在撞上**高危动作**时
 * 停下来等用户确认。对齐 Anthropic「Claude in Chrome」的 ask-before-acting /
 * act-without-asking 两档。
 *
 * 高危清单（初版，按实测再收放）：
 * - 提交 / 发送类：表单 submit、下单/支付、发帖/发消息/发邮件——把数据推出去的动作；
 * - 删除 / 不可逆变更；
 * - 跨站导航：goto 到与当前 tab 不同域名的站（与逐动作域名校验同源，主机名精确比对）；
 * - 触碰凭据 / 账号设置。
 * 非高危（自主执行、不打断）：同站导航、点击非提交按钮、滚动、exists、look（读取）、
 * 往字段里 type（**未提交前**）。
 */

/** 动作类型。look/exists 是纯读，其余会改变页面状态（mutating）。 */
export type ActionKind = 'goto' | 'back' | 'click' | 'type' | 'submit' | 'scroll' | 'exists' | 'look' | 'evaluate' | 'open' | 'setFiles'

/** 调用方声明的动作意图——用于识别那些「形态是 click/type、实质是高危」的动作。 */
export type ActionIntent = 'send' | 'publish' | 'purchase' | 'delete' | 'credential'

/**
 * 一个动作——**「做什么」，不含「在哪做」**。
 *
 * 地址不在这里是刻意的：两条 transport 的地址根本不同型（ext-cdp 是用户 Chrome 里的
 * `tabId`，cloak 是 `facility` + `laneKey`），但**做什么**和**危不危险**完全一样。
 * 门（classifyAction/needsConfirmation）从头到尾一行都没读过地址，所以地址不该在门的
 * 输入里——tabId 焊在这上面的时候，cloak 想过同一道门就得编一个假 tabId，那不是共享，
 * 是骗类型。拆开之后两条 transport 是真的在过同一道门。
 */
export interface ActionSpec {
  kind: ActionKind
  /** 该页当前所在域名（主机名）。 */
  domain: string
  /** goto 的目标 URL——用于判跨站。 */
  targetUrl?: string
  /** 高危意图声明（可选）。 */
  intent?: ActionIntent
  /** 动作的目标元素（click/type/submit/exists）。CSS 选择器。 */
  selector?: string
  /** type 要打进去的文本。 */
  text?: string
  /** scroll 的距离（像素，默认 600）。 */
  px?: number
  /** setFiles 要放进 `<input type=file>` 的本地文件路径——按**浏览器所在机器**解释（用户的 Chrome 在 Windows 上就是 `C:\\...`）。 */
  paths?: string[]
  /** look/evaluate 的页内表达式。 */
  expression?: string
  /**
   * 期望特征——动作之后**应当出现**的选择器（modal 弹层、搜索结果列表、下一页的标志…）。
   *
   * 这是 action→observe 的那个 observe：像人/Selenium 判断点击成没成，靠的是「点完页面按预期
   * 变了」，不是盲等一段时间再赌一把。传了 expect，就点完轮询它出现——出现即 `confirmed`、到
   * deadline 没出现即 `acted-unconfirmed`；不传就是 `done`（没让确认，就不假装确认）。
   */
  expect?: string
  /**
   * `kind:'open'` 在**原生窗口那一档**的入参：可执行文件（全路径，或裸文件名走 PATH）。
   *
   * 省略时 agent 按平台的常见位置找 **Chrome**（那是 `ensureApp` 的原始用途，见
   * `host-agent/src/launch.rs` 的 `resolve_exe`）——所以要开 Chrome 以外的任何应用，
   * 这一位**必填**，否则开出来的是浏览器。
   */
  exe?: string
  /**
   * `kind:'click'`（原生窗口档）的**屏幕坐标**点击：`x`/`y` 是绝对屏幕像素，两个一起给，
   * 给了就不走 a11y 定位（`selector` 可省）。
   *
   * 这一格存在的理由是**没有控件树的自绘应用**——微信 4.x 桌面版整个窗口只暴露一个自绘的
   * Pane（`MMUIRenderSubWindowHW`），role/name 一个都查不到，`selector` 那条路天然为空；
   * 而 Stream Desktop 底层本来就是按矩形中心点击的，缺的只是让调用方直接给点的口子。
   * 它一定走坐标路（先抢前台，抢不到一个输入都不发），所以别拿它做后台定时任务。
   * 坐标是**逻辑像素**（SendInput 那一套）。别直接抄 `cdp_shot` 上的数：`app:` 目标的截图
   * 是 PrintWindow 按逻辑尺寸开位图、按物理尺寸画出来的，在 200% 缩放的屏上等于物理像素 1:1 的
   * 左上角四分之一——图上的点要 ÷2 才是这里要的数。校准法与整条实测路见 drive-live-ui skill。
   */
  x?: number
  y?: number
  /**
   * `kind:'open'`（chrome 档）开进**它自己的、不抢焦点的窗口**，而不是用户那扇窗里的一张标签。
   * 给要一直跑着的页面（游戏、动画）：后台标签不出帧，而跟用户挤一扇窗就总会被挤到后台。
   * 复用只认之前这样开出来的那张，找到了不切、不抬。机制见扩展 `openInOwnWindow` 头注。
   */
  ownWindow?: boolean
  /**
   * 在哪个 **iframe** 里动手（chrome 档）：frame id（来自 `cdp_look({inventory:true})` 的
   * `frames` / 条目上的 `frame`），或 frame URL 的一段（包含匹配，命中多个就报错）。
   * 缺席 = 顶层文档；给了 `ref` 时不必给——编号全 tab 唯一，自己会找到所在的 frame。
   * 不做风险判定用（门从不读它），只是地址的一部分。
   */
  frame?: string
  /**
   * `kind:'open'`（原生窗口档）的启动参数，整体覆盖 agent 的默认值。
   *
   * 默认值是 Chrome 专属的 `--no-startup-window`（"拉起来但别开窗"）——把它原样喂给别的
   * 应用，轻则被当成要打开的文件名，重则拒绝启动。**开非 Chrome 应用一律传 `[]`**。
   */
  args?: string[]
}

/** ext-cdp 的动作 = 动作 + tab 地址（用户自己 Chrome 里的 tabId）。 */
export interface LaneAction extends ActionSpec {
  tabId: number
}

export type LaneMode = 'act-without-asking' | 'ask-before-acting'

/**
 * act 的结果。五种状态各说各的实话——尤其别再让一个 `done` 同时表示「确认成功了」和「执行了
 * 但没确认」，那正是旧 act 撒的谎：
 * - `confirmed`        —— 带了 expect，且点完那个预期特征在 deadline 内出现了（真的成了）。
 * - `acted-unconfirmed`—— 带了 expect，但特征没等到（动作发出去了，成没成不知道，也不再傻等）。
 * - `done`             —— 没带 expect：动作执行了，没让确认，就不假装确认。
 * - `not-found`        —— click/type/submit 的选择器根本没命中任何元素（无歧义：连目标都没
 *                         找到，区别于 `acted-unconfirmed`——后者是"点着了但预期没出现"，动作
 *                         本身发出去了，成没成有歧义；`not-found` 是压根没有目标可作用，没有歧义）。
 * - `needs-confirmation`—— 被高危门拦下，什么都没做。
 *
 * 住在门这里而不是某条 lane 里，因为这套形状两条 transport 的 act 都会拿回，谁也不该自己再定义一遍。
 */
export interface ActResult {
  status: 'confirmed' | 'acted-unconfirmed' | 'done' | 'not-found' | 'needs-confirmation'
  /** needs-confirmation 时说清为什么停下来问 */
  reason?: string
  result?: unknown
  /**
   * 这一下**开出了新标签**（`window.open` / `target=_blank`）——页面多半是在新标签里继续的，
   * 接着看旧标签只会得出"点了没反应"。每条的 `target` 直接就是可用的 `chrome:<tabId>` 地址。
   * 缺席 = 没看到新标签（只认 Stream 自建标签开出来的那些）。
   */
  opened?: Array<{ tabId: number; url: string; target: string }>
}

export type Risk = 'high' | 'low'

export interface ActionClass {
  risk: Risk
  /** 给人看的理由——确认门要能说清「为什么停下来问你」。 */
  reason: string
  /** 纯读动作永不打断（读不改变任何东西）。 */
  readOnly: boolean
}

const READ_ONLY: ReadonlySet<ActionKind> = new Set<ActionKind>(['look', 'exists'])

/** 形态是 click/type、实质高危的意图 → 理由。 */
const HIGH_RISK_INTENT: Record<ActionIntent, string> = {
  send: '发送类动作会把数据推出去，不可撤回',
  publish: '发布类动作会把内容公开出去，不可撤回',
  purchase: '下单/支付会产生真实交易',
  delete: '删除是不可逆变更',
  credential: '涉及凭据/账号设置',
}

/**
 * 主机名精确比对：子域算不同站（evil.a.example ≠ a.example）——放宽到后缀匹配等于给子域接管开门。
 *
 * 导出是因为**执行前的域名复核必须和门用同一把尺子**。门判"跨站"用它，复核判"页面是不是
 * 还在你说的那个域名上"也得用它——两处各写一份，迟早在某个边界上判得不一样，那道缝就是门
 * 的漏洞。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 判定一个动作的风险等级。 */
export function classifyAction(action: ActionSpec): ActionClass {
  const readOnly = READ_ONLY.has(action.kind)

  if (action.intent) {
    return { risk: 'high', reason: HIGH_RISK_INTENT[action.intent], readOnly }
  }
  if (action.kind === 'submit') {
    return { risk: 'high', reason: '表单提交会把数据推出去，不可撤回', readOnly }
  }
  // back 不算跨站导航——哪怕上一页在别的站。这道门防的是"AI 被带到一个**新的**、意料之外的
  // 地方"，而 back 定义上是回到这个 tab 刚刚待过的页面：用户和 AI 都已经看过它了。
  // 拦它还有实际害处：搜索流程本质就是跨站的（Google → 结果 → back → 下一个结果），
  // 每次 back 都问一遍会把最常用的动作变成一连串确认，而人被问多了就条件反射地点"是"——
  // 那道门在真正危险的动作（提交/下单/删除）上的价值就被消耗光了。对无害动作频繁响的门
  // 比不响更糟。（落地后若要动手，扩展侧仍会拿新域名逐动作复核，跑不掉。）
  if (action.kind === 'back') {
    return { risk: 'low', reason: '后退到本 tab 历史里的上一页——刚来过的地方，不是新去处', readOnly }
  }
  // open 开的是**一张新标签**，不动任何已有页面——和 `cdp_look({target:'chrome', url})` 同级，
  // 而那条从来就不设门。goto 的跨站门管的是另一件事：把一个**已有的** tab 劫持到别的站去
  // （用户以为它还在原来那页）。开新标签没有那个"以为"，也没有任何东西被夺走。
  if (action.kind === 'open') {
    return { risk: 'low', reason: '开一张新标签——不动任何已有页面', readOnly }
  }
  // setFiles 和 type 同级：往输入框里放东西，**没有提交**。页面拿到的是文件内容（本机文件），
  // 它要往站外传是页面自己的下一步——调用方知道那一步会发生时声明 `intent`（publish/send），
  // 让门在这里就响。
  if (action.kind === 'setFiles') {
    return { risk: 'low', reason: '把本地文件放进当前页的文件输入框（未提交）', readOnly }
  }
  if (action.kind === 'goto' && action.targetUrl) {
    const target = hostOf(action.targetUrl)
    if (target && target !== action.domain) {
      return { risk: 'high', reason: `跨站导航：${action.domain} → ${target}`, readOnly }
    }
  }
  return { risk: 'low', reason: readOnly ? '纯读取，不改变页面' : '同站的非提交动作', readOnly }
}

/**
 * 这个动作要不要停下来等用户确认？
 * - `act-without-asking`（默认）：只有高危才拦。
 * - `ask-before-acting`：每个 mutating 动作都拦；纯读仍不打断。
 */
export function needsConfirmation(action: ActionSpec, mode: LaneMode = 'act-without-asking'): boolean {
  const c = classifyAction(action)
  if (c.readOnly) return false
  if (mode === 'ask-before-acting') return true
  return c.risk === 'high'
}
