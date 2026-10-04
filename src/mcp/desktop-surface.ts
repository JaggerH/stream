import { parseAppAddress } from './cdp-target.ts'
import { DesktopUnavailable } from '../replay/desktop-failure.ts'
import type { ActOutcome, AppMatch, DesktopDriver, DesktopExpect, EnsureAppOutcome } from '../replay/desktop-driver.ts'
import type { ActionSpec } from '../replay/interactive-gate.ts'

/** 原生窗口这一档的四个动词。浏览器那三档各有各的现成实现，桌面这档集中在这里，
 *  免得 `cdp-router` 变成一个四档 × 四动词的大 switch。 */

/** `desktop` = 当前前台窗口（不指名）；`app:<process>[/<title>]` = 指名一个。 */
export function desktopMatch(scheme: 'desktop' | 'app', address?: string): AppMatch | null {
  if (scheme === 'desktop') return null // 不指名 → 用前台那个
  const { process, title } = parseAppAddress(address ?? '')
  return { process, ...(title ? { title } : {}) }
}

/** 前台窗口对应的 AppMatch——`desktop` 档要先问"现在最前面是谁"，才能把范围限定过去。 */
async function foregroundMatch(d: DesktopDriver): Promise<AppMatch> {
  const fg = (await d.windows()).find((w) => w.foreground)
  if (!fg) throw new DesktopUnavailable('no-window-match', 'no-window-match: 当前没有前台窗口')
  return { process: fg.process, title: fg.title }
}

const resolveMatch = async (d: DesktopDriver, m: AppMatch | null) => m ?? (await foregroundMatch(d))

/** `cdp_look`：读 a11y 子树。**先限定范围、不抢焦点**——看一眼不该把用户的窗口拽到前面来；
 *  而范围又不能不限，不限就是在整个桌面上搜、别的窗口的元素会漏进结果。
 *
 *  `js` 在这一档不是 JavaScript，是一段 JSON 的 a11y query（`{"role":"Button"}`）。
 *  同一个参数位换一种语言，是为了让四个动词保持一个入口——原生窗口里没有 JS 可跑。 */
export async function desktopLook(d: DesktopDriver, m: AppMatch | null, js: string): Promise<unknown> {
  const window = await d.scopeWindow(await resolveMatch(d, m))
  let query: unknown
  try {
    query = JSON.parse(js)
  } catch {
    throw new Error(
      `desktop look 的 js 是一段 JSON 的 a11y query（如 {"role":"Button"}），不是 JavaScript——原生窗口里没有 JS 可跑`,
    )
  }
  // `unbuilt` 原样带出去——**这是主战场**：这个 JSON 就是模型/人看到的东西，"这个界面上没有
  // 这个元素"和"这次根本没读到"必须在这里就分得开，而不是靠翻日志（见 `A11yFindResult`）。
  const { elements, unbuilt } = await d.find(query as { role?: string; name?: string })
  return { window, value: elements, ...(unbuilt ? { unbuilt } : {}) }
}

export async function desktopShot(d: DesktopDriver, m: AppMatch | null): Promise<string | null> {
  await d.scopeWindow(await resolveMatch(d, m))
  const buf = await d.screenshot()
  return buf ? buf.toString('base64') : null
}

export async function desktopPages(d: DesktopDriver) {
  return { pages: await d.windows() }
}

/**
 * `cdp_act({kind:'open'})` 在原生窗口这一档 = **唤起应用**（`ensureApp`：在跑就什么都不做，
 * 不在跑就拉起来并回读确认）。与 chrome 档的 `open` 同一个动词、同一层语义：那边是
 * find-or-open 一张标签，这边是 find-or-launch 一个进程；两边都**不过高危确认门**
 * （开一个应用不动任何已有窗口），也都**不要地址里那个先有鸡后有蛋的东西**。
 *
 * **它是 `bash <app>.exe` 的替代品，存在的理由就是回执**：shell 只知道"进程退了"，
 * 起没起来、复用了没有、开出了哪个窗口全不可知（撞出过两个没人管的孤儿窗口）。这里回的
 * `{running, started, pid, process, window}` 每一位都是回读出来的，`window` 拿不准时干脆缺席
 * ——指错一个比不给更坏。
 *
 * **不抢屏**：`ensureApp` 的语义只是"让进程活着"，Z 序 / 焦点 / 最小化状态一律不动。要把它
 * 拿到前面来是下一步的事（`click` 走坐标那条路时自会 focus）。
 */
export async function desktopOpen(
  d: DesktopDriver,
  m: AppMatch | null,
  spec: ActionSpec,
): Promise<{ status: 'done'; result: EnsureAppOutcome }> {
  // 指名是必须的：`desktop`（= 当前前台那个）在这里没有意义——要开的那个进程按定义还没有窗口，
  // 拿前台窗口当目标只会去"确保已经在最前面的那个应用还活着"，永远是个空动作。
  if (!m?.process) {
    throw new Error(`desktop open 要指名开谁：target 写成 app:<进程>（如 app:Telegram.exe），不是 desktop`)
  }
  // 指名了 exe 却没给 args → 明确传空数组，**不要让它落到 agent 的默认值上**：那个默认是
  // `--no-startup-window`，Chrome 专属（"拉起来但别开窗"），因为 ensureApp 原本只为唤醒用户的
  // 浏览器而生。把它喂给 Telegram 这类应用，轻则被当成要打开的文件名，重则拒绝启动。
  // 换句话说：默认参数属于"默认目标"，一旦调用方指名了别的可执行文件，它就不该被继承。
  const args = spec.args ?? (spec.exe ? [] : undefined)
  const result = await d.ensureApp({
    process: m.process,
    ...(spec.exe ? { exe: spec.exe } : {}),
    ...(args ? { args } : {}),
  })
  return { status: 'done', result }
}

/** `cdp_act`：真动手。**抢不抢屏由实际走的那条路决定**，不是一刀切先抢。
 *
 *  - `click` 命中了 a11y 元素 → 走原生 `invoke`：收件人是元素句柄，不算坐标、不受遮挡影响，
 *    **不需要前台**（锁屏也生效）。这条路一律不 `focusApp`——否则每次后台定时采集都会把用户
 *    的屏幕抢过去，而"人不在时后台干活"正是这条链路的主要用途。
 *  - 退回坐标点击、以及 `type`/`scroll`（键盘打给焦点窗口、滚轮打给光标位置）→ 必须先
 *    `focusApp`，回读失败就停在这里，一个输入都不发出。
 *
 *  两侧闸门在此对齐：agent 的 `guard_actuation` 只拦坐标 op，而坐标路在这里一定先 focusApp
 *  （由它确立 `focus_target`），所以不存在"TS 不 focus、Rust 拒收"的死路。 */
export async function desktopAct(
  d: DesktopDriver,
  m: AppMatch | null,
  spec: ActionSpec,
): Promise<ActOutcome & { window: AppMatch }> {
  const match = await resolveMatch(d, m)
  const expect = asQuery(spec.expect, 'expect')

  if (spec.kind === 'click' && (spec.x !== undefined || spec.y !== undefined)) {
    // 屏幕坐标点击：给没有控件树的自绘应用用的（见 ActionSpec.x 的头注）。没有元素可定位，
    // 所以也没有"命中句柄走 invoke"的省屏路——它一定是坐标路，一定先抢前台。
    if (spec.x === undefined || spec.y === undefined) throw new Error('desktop click: x 与 y 要一起给（绝对屏幕像素）')
    await requireForeground(d, match)
    return { ...(await d.click({ x: spec.x, y: spec.y, w: 1, h: 1 }, 'left', expect)), window: match }
  }

  if (spec.kind === 'click') {
    // 只限定搜索范围，**不碰焦点、不动 Z 序**——不然"找元素"这一步本身就把屏抢了
    await d.scopeWindow(match)
    const el = await locate(d, spec)
    if (el.ref) return { ...(await d.invoke(el.ref, expect)), window: match }
    // 没有句柄才退回坐标——到这里才需要前台
    await requireForeground(d, match)
    return { ...(await d.click(el.rect, 'left', expect)), window: match }
  }

  await requireForeground(d, match)
  return { ...(await runAction(d, spec, expect)), window: match }
}

async function requireForeground(d: DesktopDriver, match: AppMatch): Promise<void> {
  if (await d.focusApp(match)) return
  throw new DesktopUnavailable(
    'foreground-lost',
    `foreground-lost: 没能把目标窗口拿到前台（${JSON.stringify(match)}），拒绝发出输入`,
  )
}

/** 定位交给 a11y：命中后优先走原生 invoke，拿不到 ref 才退回坐标点击。 */
async function locate(d: DesktopDriver, spec: ActionSpec) {
  const q = asQuery(spec.selector, 'selector')
  if (!q) throw new Error(`desktop click 需要 selector（JSON a11y query）`)
  const { elements, unbuilt } = await d.find(q)
  const el = elements[0]
  // 「真的没有」和「根本没读到」在这里长得一模一样。agent 挂了旗就必须说出来——否则用户
  // 只看到"没有元素匹配 X"，接着去改一个一点毛病都没有的选择器。
  if (!el) throw new Error(`desktop click: 没有元素匹配 ${spec.selector}${unbuilt ? `——${unbuilt}` : ''}`)
  return el
}

/** `selector` / `expect` 在这一档是 JSON 的 a11y query，不是 CSS。同一个参数位换一种语言，
 *  是为了让四个动词保持一个入口——原生窗口里没有 DOM 可选。 */
function asQuery(raw: string | undefined, field: string): DesktopExpect | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as DesktopExpect
  } catch {
    throw new Error(`desktop act 的 ${field} 是一段 JSON 的 a11y query（如 {"role":"Button","name":"确定"}），不是 CSS 选择器`)
  }
}

/** `click` 之外的动作——它们都要前台，调用方已经确权过了。 */
async function runAction(d: DesktopDriver, spec: ActionSpec, expect?: DesktopExpect): Promise<ActOutcome> {
  switch (spec.kind) {
    case 'type':
      return d.type(spec.text ?? '', expect)
    case 'scroll': {
      const px = spec.px ?? 600
      return d.scroll(px < 0 ? 'up' : 'down', Math.abs(px), expect)
    }
    default:
      throw new Error(`desktop act 不支持 kind:'${spec.kind}'（原生窗口没有 goto/back/submit 这些概念）`)
  }
}
