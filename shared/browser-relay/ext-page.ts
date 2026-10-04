/**
 * 翻译层在扩展中继上的**唯一实现**：把 {@link PageDriver} 的每个动词落成 CDP 命令。
 *
 * 扩展是一根通用 CDP 管子（`dispatch` 把 `{method,params}` 转给 `chrome.debugger.sendCommand`），
 * 所以整个 driver 住在调用方进程里——扩展里不跑任何动作逻辑。
 *
 * - `evalExpr` → 一条 `Runtime.evaluate`（`returnByValue`）做 DOM 读。
 * - `cdp` → 任意原始 CDP 命令；`Input.*` 产生**可信**手势（`isTrusted=true`），这正是要害:
 *   JS 的 `scrollBy` 不产生可信滚轮事件，一眼就是自动化。
 *
 * **两个宿主的差异一律走参数,不走第二份实现**（见 {@link ExtDriveOptions} 与
 * {@link RawPageOptions}）。往这里加一个 `if (isPlugin)` 之前先想清楚:那就是漂移的起点。
 */
import type { PageDriver, ScrollGeometry } from './page-driver.ts'
// type-only：编译期擦除，不进运行时闭包（`closure.test.ts` 只跟 value import）。
import type { DebugEntry } from '../../src/debug.ts'

/** `ExtRawPage` 需要的中继面。比 `ExtRelay` 窄，好让假货保持小。 */
export interface RawPageRelay {
  /** `sessionId` 缺席 = tab 的主会话；给了就打给那张 tab 里某个 OOPIF 的子会话（见 `frames.ts`）。 */
  sendCommand(tabId: number, method: string, params: unknown, expectDomain?: string, sessionId?: string): Promise<any>
}

/** 开一张 driver 用的标签所需的中继面。 */
export interface TabOpeningRelay extends RawPageRelay {
  newTab(url: string, waitUntil?: string, background?: boolean): Promise<number>
}

/** 一张 ext-cdp 标签的底层句柄。 */
export interface ExtRawPage {
  tabId: number
  /**
   * 一条 `Runtime.evaluate`。
   *
   * `unguarded` 只有在 {@link RawPageOptions.guardEvals} 开着时才有意义：把这一次求值排除在
   * 域名复核之外。用它的地方只有 `goto` 的两处探针——见 `goto` 里的说明。
   */
  evalExpr<T = unknown>(expression: string, opts?: { unguarded?: boolean }): Promise<T>
  cdp(method: string, params?: unknown): Promise<unknown>
}

export interface RawPageOptions {
  /**
   * **`Runtime.evaluate` 也带上 `expectDomain`。**
   *
   * 默认关（Stream 后端）：后端跑的是仓库里审过的 recipe 表达式,读一个已经跳走的页面只会
   * 读到没用的东西,落不到别的站上。
   *
   * 插件那侧开着,理由是求值的**来源不同**:那里跑的是**模型现写的 JS**,落在用户自己那个带着
   * 全部登录态的 Chrome 上——页面在动作中途跳走时,扩展侧那次域名复核是唯一拦住「模型写的
   * 表达式在另一个站上执行」的东西。代价说在明处:跳走之后连 click 的读矩形也会被拒,于是
   * 表现成一个笼统的失败,而后端那侧读还能成功、只有输入被拒(一个干净的 not-found 路径)。
   */
  guardEvals?: boolean
}

/**
 * 造一个 `ExtRawPage`——**唯一知道 CDP 回包怎么拆包（`result.value`）、页内抛错怎么冒出来
 * （`exceptionDetails`）的地方**。页内抛的错必须原样冒出来:吞掉它等于把「选择器写错了」
 * 变成一个静默的 undefined。
 *
 * `expectDomain` 给了就随每条命令一起下去,扩展在执行前**紧接着**复核一次 tab 的域名:页面
 * 若在动作中途跳走了,这条动作会被拒,而不是落到另一个站上。
 */
export function makeExtRawPage(
  relay: RawPageRelay,
  tabId: number,
  expectDomain?: string,
  opts: RawPageOptions = {},
): ExtRawPage {
  const evalDomain = (unguarded: boolean | undefined): string | undefined =>
    opts.guardEvals && unguarded !== true ? expectDomain : undefined
  return {
    tabId,
    evalExpr: async <T>(expression: string, o?: { unguarded?: boolean }): Promise<T> => {
      const res = await relay.sendCommand(
        tabId,
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        evalDomain(o?.unguarded),
      )
      if (res?.exceptionDetails) {
        const d = res.exceptionDetails
        throw new Error(d.exception?.description ?? d.text ?? 'in-page evaluate threw')
      }
      return res?.result?.value as T
    },
    cdp: (method: string, params?: unknown): Promise<unknown> =>
      relay.sendCommand(tabId, method, params ?? {}, expectDomain),
  }
}

/**
 * `click` 等目标出现的上界。
 *
 * **轮询而不是读一次**:cloak 那份点击自带 auto-wait(Playwright 语义),所以这份也必须等,
 * 否则同一份 recipe 换条 transport 行为就不一样。真实表单常常是上一个控件解决了才渲染下一个
 * ——Groq 的提交按钮要等 Turnstile 的 token 落地才出现——所以「还没到」和「没有」是两个答案。
 */
export const CLICK_WAIT_MS = 5000

/**
 * `goto` 等新文档 readyState 的上界。
 *
 * **它超时之后不报错、不改行为**(照旧 return,让后面的 `expect` 去判),所以在留痕之前它和
 * "等到了"走同一个出口——上层只看得见"这一步花了 15.9 秒",看不见它花在哪。2026-08-14 一次
 * web_search 冷跑里 Google 那条腿的 `step#0 goto` 实测 15878ms / 15969ms(同一查询另两次只要
 * 5.3s / 6.8s),整条链路上唯一能对上这个数的闸门就是它;而一轮 34 次冷搜索、81 次 goto 的
 * 临时埋点 81/81 都走的 `satisfied` 出口——**蹲不到,正是因为这里不留痕**。
 */
export const GOTO_READY_BUDGET_MS = 15_000
const GOTO_POLL_MS = 100

export interface ExtDriveOptions {
  /** DebugBox / `GET /api/debug/log?channel=drive` 的入口。不给 = 不留痕(测试与插件宿主)。 */
  onDebug?: (entry: DebugEntry) => void
  /**
   * **点击/移动前把光标「走」过去**,而不是瞬移。默认开。
   *
   * 开着时分步 dispatch 8 次 `mouseMoved`,并跨步记住光标停在哪(下一次从那儿出发)。这是有
   * 活体代价换来的:2026-07-25 console.groq.com 建 API key,人手点能过 Cloudflare Turnstile,
   * 瞬移点过不了(挑战跑完复位、`cf-turnstile-response` 恒空、提交按钮因此从不渲染)。排除过的:
   * `navigator.webdriver` 为 false、无 CDP/selenium 痕迹、真实 profile/IP、调试器附着也不是
   * 原因(附着状态下人手点照样过)。剩下的差别就是这条轨迹。步数对齐 cloak 的
   * `page.mouse.move(x, y, { steps: 8 })`;每步之间留一点时间,否则 8 个事件落在同一毫秒里,
   * 那不是「走过去」,只是「瞬移拆成了八份」。
   *
   * 插件那侧关掉:它面向的是「AI 帮我操作我自己的浏览器」,不是绕过风控采集。关掉之后按下前
   * 仍然发一次 `mouseMoved`——不发 move 的点击在很多页面上连 hover 态都不会进,紧跟着的
   * press 会落在一个还没准备好的元素上。
   */
  humanCursor?: boolean
}

/**
 * 开一张给 driver 用的标签——**每一张自己开的 tab 都要走它**。
 *
 * `Emulation.setFocusEmulationEnabled` 这一条是整条链上最贵的东西的开关。
 * 活体测量(2026-07-29,靶子是 example.com——完全静态、页面自己零活动,所以量到的纯粹是浏览器
 * 行为;同一个 tab、同一段可信点击 = 8 次 mouseMoved + 按下 + 松开):
 *
 * | 条件                                   | 一次点击            |
 * |----------------------------------------|---------------------|
 * | 它是活动标签(前台)                      | 204–257ms   (5/5)   |
 * | 隐藏,什么都不做                         | **39.8–41.6s** (5/5)|
 * | 隐藏 + `Page.startScreencast`           | 39.8s(无效)          |
 * | 隐藏 + 每个动作后逼一帧                  | 267ms/1.2s/39.8s 不稳|
 * | **隐藏 + 本开关**                       | **162–185ms** (5/5) |
 *
 * 中继的命令超时是 30 秒——也就是说不开这一条,后台标签上的每次输入**必然超时**,而表现是
 * 「浏览器工具随机超时」,没有一处会喊。**前台那一档也照发**:它此刻在前台不代表下一次动作时
 * 还在(交出去的 tabId 是个「你接着用」的句柄,用户下一秒就可能切走)。
 *
 * 病理:隐藏 tab 的可信输入在等下一帧,而浏览器不打算给看不见的 tab 画——每个输入事件约等 4 秒。
 * 逼一帧能让流水线热一小会儿(所以那一档忽快忽慢),screencast 无效是因为 CDP 要求逐帧
 * `Page.screencastFrameAck`,而扩展的事件转发按订阅过滤、没人订 `Page` 域 → 没人 ack → 只吐
 * 一帧就停。**第四行是历史证据,不是今天的选项**:这个 driver 一帧都不逼,理由见 `sleep`。
 *
 * **它撒的谎**(说清楚,别粉饰):开启后页面读到 `hasFocus()===true`,而这个 tab 其实在后台
 * (A/B 实测:开关 ON 的背景标签读 true、OFF 读 false,判据干净地跟着开关走)。页面内部自洽,
 * 能被统计到的是「整个会话从不 blur」。`visibilityState` 是不是也被一起改写,**没有实验证实**
 * ——同一次实验里三个标签(含没开开关的那个)全读 `visible`,而那几个标签的窗口几何完全重合,
 * 这个实验本身就分不出它们,别把它当结论用。
 *
 * **它救不了什么:要合成器真产出一帧的命令。** 开关给的是"页面被当成有焦点"这个谎,可信输入
 * 等的正是这个谎(39.8s → 165ms);而 `Page.captureScreenshot` 等的是**真的有一帧**,那由 OS
 * 那层"这个 Chrome 窗口到底显不显示在屏幕上"说了算,页面撒的谎管不着。A/B 对照:开关 ON 也
 * 照样挂(18.66s、12.03s),OFF 挂(26.08s、30.00s×4),两个 arm 都挂过——开关不是自变量。
 * **别把"输入被救了"读成"帧的问题解决了"。**
 *
 * **上表第五行(162–185ms)今天复现不出来,别把它当保证。** 2026-09-03 同样开着这个开关、
 * 同样的后台标签(example.org),一次可信点击实测 5.9 / 9.7 / 6.5 秒——每个鼠标事件的回执
 * 还是要等 0.5–0.9 秒。而页内探针同时显示 11 个事件**在 262ms 内全都送达了页面**:开关救的
 * 是"事件到不到得了",救不稳"回执几时回来"。回执那一半现在由扩展接住(`driver.ts` 的
 * `FIRE_AND_FORGET`),**这个开关照旧要开**——两者管的不是同一件事,别因为点击变快了就撤它。
 *
 * `.catch` 吞掉:开关没开上不该让这次调用失败(旧扩展 / 命令不支持),只是慢。
 */
export async function openDrivenTab(
  relay: TabOpeningRelay,
  url: string,
  opts: { waitUntil?: string; background?: boolean } = {},
): Promise<number> {
  const tabId = await relay.newTab(url, opts.waitUntil, opts.background !== false)
  await relay.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  return tabId
}

/** 「这两个 URL 是同一个页面吗」——origin + pathname 相同即算(query / hash 变了还是那一页)。 */
function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.origin === ub.origin && ua.pathname === ub.pathname
  } catch {
    return false
  }
}

/**
 * {@link makeExtPageDriver} 的返回类型:翻译层的全部动词,外加一个**按坐标点**的原语。
 *
 * `clickAt` 不在 {@link PageDriver} 里,因为不是每种 driver 都能按坐标点(Playwright 那份走的是
 * `locator.click()`);但它确实是翻译层的东西——"在这个点上按一下"不认识任何业务概念。采集侧
 * 的 `openItem` / `openTarget`(点信息流第 N 条、点身份为 X 的那张卡)自己算出坐标之后要落到
 * 页面上,走的就是它。**这样光标位置只有一份状态**:轨迹的起点仍然连续。
 */
export type ExtPageDriver = PageDriver & {
  clickAt(x: number, y: number): Promise<void>
}

/**
 * 翻译层的实现:一张 ext-cdp 标签 → 一个 {@link PageDriver}。
 *
 * 可信手势走 CDP `Input.*`,DOM 读走 `Runtime.evaluate`。
 */
export function makeExtPageDriver(raw: ExtRawPage, opts: ExtDriveOptions = {}): ExtPageDriver {
  const humanCursor = opts.humanCursor !== false

  // 光标位置,给滚轮/点击当原点。惰性居中,好让滚轮事件落在可滚动的文档上,像一个真光标。
  // **只有开着「走过去」时才跨步记住**:那个记忆的全部意义就是给下一次轨迹当起点。
  let pos: { x: number; y: number } | null = null
  const at = async (): Promise<{ x: number; y: number }> => {
    if (pos) return pos
    // **这次读失败必须冒出来。** 它常常是这条动作里唯一一次往中继上的问路:中继断了 / tab 没了,
    // 拒绝就在这儿。曾经这里挂着 `.catch(() => null)`,于是失败被回落成「视口中心 640,400」,
    // 紧跟着的滚轮命令也被 `.catch` 吞掉,而 scroll 既不是选择器动作、又常常不带 `expect`,
    // 于是照报成功——**这条链路上唯一一处静默的假成功**:模型被告知滚过了,回头一读还是原来
    // 那屏,多半就地打转。**回落只兜「答回来的值形状不对」,不兜「这一问就没问着」。**
    const c = await raw.evalExpr<{ x: number; y: number }>(
      '(()=>({x:Math.floor(innerWidth/2),y:Math.floor(innerHeight/2)}))()',
    )
    const centre = c && typeof c.x === 'number' ? c : { x: 640, y: 400 }
    if (humanCursor) pos = centre
    return centre
  }

  const TRAVEL_STEPS = 8
  const moveTo = async (x: number, y: number): Promise<void> => {
    // 显式带上时间戳,别让浏览器按「送达时刻」自己盖章。轨迹是有活体代价换来的(见
    // `humanCursor`),而只要这几个事件因为任何原因挤在同一毫秒里送达,页面看到的就是一次瞬移。
    // 钉时间戳把"什么时候发生"从"什么时候送到"里摘出来,是免费的,所以不管送达节奏如何都成立。
    const ts = (): number => Date.now() / 1000
    if (!humanCursor) {
      await raw.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, timestamp: ts() })
      return
    }
    const from = await at()
    for (let i = 1; i <= TRAVEL_STEPS; i++) {
      const t = i / TRAVEL_STEPS
      await raw.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (x - from.x) * t),
        y: Math.round(from.y + (y - from.y) * t),
        timestamp: ts(),
      })
      await new Promise((r) => setTimeout(r, 8 + Math.floor(Math.random() * 12)))
    }
    pos = { x, y }
  }

  const clickAt = async (x: number, y: number): Promise<void> => {
    await moveTo(x, y)
    const ts = (): number => Date.now() / 1000
    await raw.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, timestamp: ts() })
    await raw.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, timestamp: ts() })
    if (humanCursor) pos = { x, y }
  }

  /** 聚焦并把「找没找到」一次答出来——另起一次探测会在两次求值之间给页面一个变样的机会。 */
  const focusAndFound = (selector: string): Promise<boolean> =>
    raw.evalExpr<boolean>(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(el)el.focus(); return !!el;})()`,
    )

  return {
    clickAt,
    async goto(url: string, waitUntil?: string): Promise<void> {
      // `Page.navigate` 在命令 ack 时就 resolve,而那一刻**旧文档还在,且它的 readyState 早就是
      // 'complete'**——只看 readyState 的条件会被「正要离开的那一页」当场满足,goto 立刻返回,
      // 紧接着的读拿到的是旧 DOM,并把它当成新页面报上去。所以判据是「ready **且** 文档真的
      // 换了」:href 变了,或者目标本来就是同一页(同 origin+pathname 的重新加载,href 不会变)。
      //
      // **这两处探针故意不做域名复核**(`unguarded`)。复核的判据是「tab 当前 URL 精确等于发起
      // 动作时的那个域名」——对一次确认过的跨站 goto 这个判据永远为假:读之前 tab 早就换域了,
      // 逢读必拒,`.catch` 把拒绝吞成「没问着」,于是干等满 15 秒。而这两条表达式是本文件里写死
      // 的固定字符串,不是模型现写的 JS,`guardEvals` 要防的那件事在这里根本不成立。要防的是
      // `Page.navigate` 本身落错地方,那道门在下面那一行(`cdp` 恒带 `expectDomain`)。
      const before = await raw.evalExpr<string>('location.href', { unguarded: true }).catch(() => null)
      await raw.cdp('Page.navigate', { url })
      if (waitUntil === 'commit') return
      const ready = waitUntil === 'domcontentloaded'
        ? new Set(['interactive', 'complete'])
        : new Set(['complete'])
      const startedAt = Date.now()
      const deadline = startedAt + GOTO_READY_BUDGET_MS
      // 超时那一笔要能回答"当时页面停在哪",所以记住最后一次**读到的**快照(读失败不覆盖它——
      // 文档交换期间 evaluate 本来就会失败,那不是页面的状态,只是我们没问着)。
      let lastSnap: { href: string; state: string } | null = null
      let failedReads = 0
      while (Date.now() < deadline) {
        const snap = await raw
          .evalExpr<{ href: string; state: string }>(
            '(()=>({href:location.href,state:document.readyState}))()',
            { unguarded: true },
          )
          .catch(() => null)
        if (snap) lastSnap = snap
        else failedReads++
        if (snap && ready.has(snap.state) && (snap.href !== before || samePage(snap.href, url))) {
          // 这里不逼帧。曾经逼过,理由是「背景档下布局也被压着,按矩形定位的读会拿到没算完的
          // 几何」——2026-08-15 实测**那个理由不成立**:后台标签零逼帧时 xhs 首页的
          // scrollHeight 就是 2983/3022(不是视口高 893),布局是算完的。
          return
        }
        await new Promise((r) => setTimeout(r, GOTO_POLL_MS))
      }
      // 走到这里 = 撞了 deadline。**行为不变**(照旧返回,判据仍在后面的 expect),只留一笔痕:
      // 没有它,这个出口和"等到了"长得一模一样,只能靠蹲守。
      const at = Date.now()
      opts.onDebug?.({
        id: `drive:goto-timeout:${raw.tabId}@${at}`,
        at,
        channel: 'drive',
        key: `tab:${raw.tabId}`,
        title: 'goto 等 readyState 超时',
        summary:
          `${(GOTO_READY_BUDGET_MS / 1000).toFixed(0)}s 没等到 ${[...ready].join('/')};` +
          `页面停在 ${lastSnap ? `${lastSnap.state} · ${lastSnap.href}` : '(一次都没读到)'}`,
        ok: false,
        fields: [
          { label: '目标 url', value: url },
          { label: '等的状态', value: [...ready].join('/') },
          { label: '最后 readyState', value: lastSnap?.state ?? '(读不到)', tone: 'warn' },
          { label: '最后 href', value: lastSnap?.href ?? '(读不到)', tone: 'warn' },
          { label: '导航前 href', value: before ?? '(读不到)', tone: 'muted' },
          { label: 'tab', value: String(raw.tabId), tone: 'muted' },
          { label: '等了', value: `${at - startedAt}ms`, tone: 'warn' },
          { label: '读失败次数', value: String(failedReads), tone: failedReads > 0 ? 'warn' : 'muted' },
        ],
      })
    },
    async currentUrl(): Promise<string> {
      return raw.evalExpr<string>('location.href')
    },
    async scrollOnce(px: number): Promise<void> {
      const { x, y } = await at()
      // 可信滚轮——不是 `window.scrollBy`(后者不产生可信 wheel 事件)。
      //
      // **不等回执。** 背景档下这条命令的 ack 永不返回(实测两次:中继 30s 超时报错,而
      // `scrollY` 确实变了——动作成功、回执丢了)。等它 = 每滚一屏白等 30 秒然后收一个假故障。
      //
      // 这条毛病现在被**扩展那一侧**统一接住了(`driver.ts` 的 `FIRE_AND_FORGET`:可信鼠标
      // 事件发了就算,回执约 36ms 就回来)。这里仍然留着 `void`,是给**版本落差**兜底——
      // 用户装的扩展可能比后端旧,那一档下等回执照旧是 30 秒。
      // 判据落在消费者一侧:滚没滚动看实际位移,不看发送方的回执(观察四律 §4)。
      // 注意这里**只吞这一条命令的错**,不是把超时整类忽略掉——真正挂死的 evaluate 仍要冒出来。
      void raw
        .cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: px, timestamp: Date.now() / 1000 })
        .catch(() => {})
    },
    async scrollProbe(): Promise<ScrollGeometry> {
      return (
        (await raw.evalExpr<ScrollGeometry>(
          '(()=>({scrollY:Math.round(window.scrollY||window.pageYOffset||0),viewportH:window.innerHeight||0,scrollHeight:Math.max((document.documentElement&&document.documentElement.scrollHeight)||0,(document.body&&document.body.scrollHeight)||0)}))()',
        )) ?? { scrollY: 0, viewportH: 0, scrollHeight: 0 }
      )
    },
    async click(selector: string, position?: { x: number; y: number }): Promise<boolean> {
      // 读矩形再瞄准:`position` 是相对左上角的偏移,不给就是中心。偏移在**这里**换算(不在页内),
      // 好让同一组数字在两条 transport 上意思一样。
      const readRect = () =>
        raw.evalExpr<{ left: number; top: number; width: number; height: number } | null>(
          `(()=>{const el=document.querySelector(${JSON.stringify(
            selector,
          )});if(!el)return null;const r=el.getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height}})()`,
        )
      let rect = await readRect()
      const deadline = Date.now() + CLICK_WAIT_MS
      while (!rect && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150))
        rect = await readRect()
      }
      if (!rect) return false
      const x = Math.floor(rect.left + (position ? position.x : rect.width / 2))
      const y = Math.floor(rect.top + (position ? position.y : rect.height / 2))
      await clickAt(x, y)
      return true
    },
    /**
     * 截一个元素。**先在页内把它画出来，画不出来才去截屏。**
     *
     * 为什么这个次序（2026-09-02 活体实测得出，别调回去）：截屏要合成器**真的产出一帧**，
     * 而被盖住/最小化/锁屏的窗口不产帧——于是"无人值守的定时任务在锁着屏的早上截验证码"
     * 这件事在截屏那条路上是**做不到**的。两种强制产帧都试过、都不行：
     * `Emulation.setFocusEmulationEnabled` 只是页面级的谎（帧归合成路径管）；
     * `Emulation.setDeviceMetricsOverride` 自己就会挂住不回（要的正是那个不干活的渲染器）；
     * `captureBeyondViewport` 在新版 Chrome 里已被移除，传了回 CDP `Internal error`。
     *
     * 而 `<img>` / `<canvas>` 的像素**本来就在页面进程里**：画进 canvas 读出来完全不经合成器，
     * 窗口显不显示都一样。顺带还更准——不受窗口缩放、DPR、遮挡影响，拿到的是原始尺寸。
     *
     * 跨源图会污染画布，`toDataURL` 抛 SecurityError —— 那种就回落到截屏（页内 try 住，
     * 别让整次读作废）。
     *
     * **一张还在加载的 `<img>` 回 `null`（"还没好"），不回落到截屏。** 这一条是活体逼出来的：
     * 点一下验证码图 = 换一张，此后 `complete` 有一小段是 false；那会儿回落到截屏，正好落进
     * 上面说的"截不到"里，于是整条链在"刚点完刷新"这一刻必然失败。而 `null` 在调用方那边
     * 本来就是"还没好、接着等"（见 `waitForSettle` 立基线那段），语义天然对得上——
     * 回落到一张半成品截图反而是更差的答案。
     */
    async shotOf(selector: string): Promise<string | null> {
      const r = await raw.evalExpr<
        { x: number; y: number; width: number; height: number; data?: string | null; loading?: boolean } | null
      >(
        `(()=>{const el=document.querySelector(${JSON.stringify(
          selector,
        )});if(!el)return null;const b=el.getBoundingClientRect();if(!b.width||!b.height)return null;` +
          `let data=null,loading=false;try{` +
          `if(el.tagName==='CANVAS')data=el.toDataURL('image/jpeg',0.8);` +
          `else if(el.tagName==='IMG'){` +
          `if(!el.complete||!el.naturalWidth)loading=true;else{` +
          `const c=document.createElement('canvas');c.width=el.naturalWidth;c.height=el.naturalHeight;` +
          `c.getContext('2d').drawImage(el,0,0);data=c.toDataURL('image/jpeg',0.8);}}` +
          `}catch(e){data=null}` +
          `return{x:b.left+window.scrollX,y:b.top+window.scrollY,width:b.width,height:b.height,data,loading}})()`,
      )
      if (!r) return null
      // 还在加载 → "还没好"，别回落到截屏（见上面头注最后一段）。
      if (r.loading === true) return null
      // 页内画成了就直接用——不碰合成器，遮挡窗口照样有图。
      if (typeof r.data === 'string' && r.data.startsWith('data:image/')) {
        const comma = r.data.indexOf(',')
        if (comma > 0) return r.data.slice(comma + 1)
      }
      // captureBeyondViewport:false —— 只要当前视口里那块。scale:1 固定下来,免得 DPR 变化
      // 让两帧字节不同却其实是同一幅画面。
      const shot = (await raw.cdp('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 80,
        clip: { ...r, scale: 1 },
        captureBeyondViewport: false,
      })) as { data?: string } | undefined
      return shot?.data ?? null
    },
    /**
     * 整屏（当前视口）一张，给人和模型看——**不经元素矩形**，所以不受"滚了二十屏之后
     * body 有二十个视口那么高"的影响（那正是 `shotOf('body')` 在这条路上必然失败的原因）。
     */
    async shotViewport(): Promise<string | null> {
      const shot = (await raw.cdp('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
        captureBeyondViewport: false,
      })) as { data?: string } | undefined
      return shot?.data ?? null
    },
    async back(): Promise<void> {
      // `history.back()`,不是 `Page.navigate` 回旧 URL:后者语义上是「去一个新地方」(丢前进
      // 历史、重新加载、还会被高危门当跨站拦),而调用方要的就是浏览器那个后退键。
      await raw.evalExpr('history.back()')
    },
    async type(selector: string, text: string): Promise<boolean> {
      if (!(await focusAndFound(selector))) return false
      // 先可信全选:`insertText` 替换选区,所以复用的输入框(持久 tab、第二次搜索)不会把新值
      // 追加在旧值后面。
      const ctrl = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 }
      const a = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }
      await raw.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrl })
      await raw.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...a })
      await raw.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...a })
      await raw.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrl })
      await raw.cdp('Input.insertText', { text })
      return true
    },
    async submit(selector: string): Promise<boolean> {
      if (!(await focusAndFound(selector))) return false
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await raw.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await raw.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      return true
    },
    /**
     * 等一会儿。**就是等,不做别的**——这个 driver 一帧都不逼。
     *
     * 曾经它按 250ms 一拍打 1×1 截图("心跳"),理由是后台标签一睡就冻结、dwell 等的那件事
     * 不会发生。**那条理由已经被逐格证伪,而且它最后一个消费者也走了**:
     *
     * - 可信输入不需要帧 —— `Emulation.setFocusEmulationEnabled` 接住(见 `openDrivenTab`)。
     * - xhs 的懒加载不需要帧 —— 后台标签零逼帧实测:定时器 40/40 拍、`rAF` 在跑、
     *   `scrollHeight` 2983 → 6978;带计数的 A/B 里 `xhs-home` 关掉心跳照样 110–113 条
     *   (开着是 109–112)。
     * - 唯一真的要帧的是 douyin,而 `douyin-search` 已改成站内直调(`evaluate` step),
     *   **不再滚动、不再 sleep**。
     *
     * **要加回来之前先量。** 判据是产出(抓到几条),不是耗时;而且"要不要帧"是**站点差异**,
     * 不是通用规律——新站点得自己现测,别照这段注释推断任何一侧。历史证据与量法见
     * `write-recipe/references/session-runtime.md`。
     */
    async sleep(ms: number): Promise<void> {
      await new Promise((r) => setTimeout(r, ms))
    },
    async exists(selector: string): Promise<boolean> {
      return !!(await raw.evalExpr<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`))
    },
    async evalJson(expression: string): Promise<unknown> {
      // `Runtime.evaluate` 带 awaitPromise+returnByValue(`evalExpr` 已经两样都做了):
      // 在登录态标签里跑调用方给的表达式并返回它的 JSON。
      return raw.evalExpr(expression)
    },
    async setFiles(selector: string, paths: string[]) {
      // 先在页内认元素：选择器命中、且真是 <input type=file>——两种失败各报各的，别让 CDP 那句
      // 笼统的 "Node is not a file input" 替它们说话。
      const probe = await raw.evalExpr<{ found: boolean; tag?: string; type?: string; multiple?: boolean }>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found: false }; return { found: true, tag: el.tagName, type: (el.getAttribute('type') || '').toLowerCase(), multiple: !!el.multiple }; })()`,
      )
      if (!probe?.found) throw new Error(`setFiles: 选择器没命中任何元素：${selector}`)
      if (probe.tag !== 'INPUT' || probe.type !== 'file') {
        throw new Error(`setFiles: ${selector} 命中的是 <${String(probe.tag).toLowerCase()}${probe.type ? ` type=${probe.type}` : ''}>，不是 <input type=file>`)
      }
      if (paths.length > 1 && !probe.multiple) throw new Error(`setFiles: ${selector} 不是 multiple，只能放一个文件（给了 ${paths.length} 个）`)
      // DOM.setFileInputFiles 要 nodeId：先 getDocument 拿根，再 querySelector。文件由浏览器进程读，
      // 路径按浏览器那台机器解释；不存在的路径 CDP 会拒（原文抛回去）。
      const doc = (await raw.cdp('DOM.getDocument', { depth: 0 })) as { root?: { nodeId?: number } }
      const rootId = doc?.root?.nodeId
      if (typeof rootId !== 'number') throw new Error('setFiles: DOM.getDocument 没回根节点')
      const hit = (await raw.cdp('DOM.querySelector', { nodeId: rootId, selector })) as { nodeId?: number }
      if (!hit?.nodeId) throw new Error(`setFiles: DOM.querySelector 没命中（页内 querySelector 命中了——元素可能在 shadow root / iframe 里，CDP 的选择器不穿透）：${selector}`)
      // 先挂一个 capture 的 change 监听把 files 抄下来：很多站（Photopea 就是）读完就把 input.value
      // 清空，事后再读 el.files 只剩空数组、分不清"页面消费了"和"根本没放进去"。target 阶段 capture
      // 监听先于页面自己的处理器跑（Chrome 89+ 的顺序），抄到的就是页面看到的那一份。
      const sel = JSON.stringify(selector)
      await raw.evalExpr(
        `(() => { const el = document.querySelector(${sel}); window.__streamSetFiles = null; el.addEventListener('change', () => { window.__streamSetFiles = [...(el.files || [])].map(f => ({ name: f.name, type: f.type, size: f.size })); }, { once: true, capture: true }); return true; })()`,
      )
      try {
        await raw.cdp('DOM.setFileInputFiles', { files: paths, nodeId: hit.nodeId })
      } catch (e) {
        throw new Error(`setFiles: DOM.setFileInputFiles 被拒（路径按浏览器所在机器解释，WSL 路径要先转成 Windows 路径）：${e instanceof Error ? e.message : String(e)}`)
      }
      // 回页面真拿到了什么（name/type/size 来自 File 对象）——这是"放进去了"的唯一证据，
      // CDP 命令返回了不算。
      const files =
        (await raw.evalExpr<{ name: string; type: string; size: number }[] | null>(
          `(() => { const got = window.__streamSetFiles; delete window.__streamSetFiles; if (got) return got; const el = document.querySelector(${sel}); return [...(el && el.files ? el.files : [])].map(f => ({ name: f.name, type: f.type, size: f.size })); })()`,
        )) ?? []
      // CDP 不核路径存不存在：给一个不存在的路径，页面照样收到一个 0 字节的 File、change 照发
      // （2026-09-20 活体）。全是 0 字节就当没放进去——真实文件恰好 0 字节远少于"路径写错 / WSL 路径没转"。
      if (files.length && files.every((f) => f.size === 0)) {
        throw new Error(`setFiles: 浏览器没读到文件内容（${files.map((f) => f.name).join(', ')} 都是 0 字节）——不存在的路径 CDP 不报错；路径按浏览器所在机器解释，WSL 路径要先转成 Windows 路径（/mnt/c/… → C:\\…）`)
      }
      if (!files.length) throw new Error(`setFiles: 页面没收到 change（${selector} 上没有 files）——元素可能被页面替换了，或选择器命中的不是页面真正监听的那个输入框`)
      return files
    },
    async moveMouse(x: number, y: number): Promise<void> {
      await moveTo(x, y)
    },
  }
}
