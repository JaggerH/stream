/**
 * 把一个动作落到页面上——**统一走 {@link PageDriver}**，不另搓一份 CDP 映射。
 *
 * 只吃 driver，所以它对 transport 一无所知：ext-cdp 的 driver、cloak 的 driver、插件宿主的
 * driver 因此共用这一份落地逻辑，而不是各写一份"看起来一样"的。
 *
 * 这里曾经有过一份手搓 CDP 映射，每条都是坏的：click 发的 dispatchMouseEvent 不带 x/y
 * （CDP 必需）且只有 mousePressed 没有 mouseReleased，页面根本不认；type 永远发 text:''；
 * submit 被映射成鼠标按下。真正的病根不是手滑，是动作当时不带 selector/text —— 动作没有目标，
 * 那份映射不可能写对，它是在给类型缺口打补丁。
 *
 * driver 那份是对的且已在采集链路上跑熟了：可信三连点击、focus+全选再 insertText（复用 tab
 * 不会把新值追加到旧值后面）、Enter 提交、带 x/y 的可信滚轮（JS scrollBy 不产生可信事件，
 * 会被认出是自动化）、goto 后轮询 readyState。
 */
import type { ActionSpec } from './interactive-gate.ts'
import { waitForSelector, type PageDriver } from './page-driver.ts'

/** click/type/submit 的目标是一个 CSS 选择器——「没找到」是这三个动作独有的、调用方必须知道
 *  的事实。其余动作没有这个问题：`exists` 返回 false 是一个正常读数（页面上确实没有），
 *  不是「动作没找到目标」，{@link actWithConfirm} 靠 `action.kind` 分辨这两种 false。 */
const SELECTOR_TARGETED: ReadonlySet<ActionSpec['kind']> = new Set(['click', 'type', 'submit'])

export async function runAction(driver: PageDriver, action: ActionSpec): Promise<unknown> {
  // 缺字段就报「哪个动作缺哪个字段」。动作名取自 action.kind 本身，不由各分支各传一遍——
  // 传的那份一旦和所在分支对不上，报出来的就是条假消息。
  function need(v: string | undefined, what: string): string {
    if (!v) throw new Error(`${action.kind} 动作缺 ${what}`)
    return v
  }
  switch (action.kind) {
    case 'goto':
      await driver.goto(need(action.targetUrl, 'targetUrl'), 'domcontentloaded')
      return undefined
    case 'back':
      await driver.back()
      return undefined
    case 'click':
      // 点第一个命中元素的中心（可信 move→press→release）。返回值是"找没找到"——一次点在
      // 空气上的点击是调用方需要知道的事实，不是静默的空操作。
      return driver.click(need(action.selector, 'selector'))
    case 'type':
      // 同上：找没找到目标，比"insertText 调用返回了"重要得多——没找到还接着打字，文本会落在
      // 别的焦点上（或哪儿都不去），后面只会以一个不相关的症状失败。
      return driver.type(need(action.selector, 'selector'), need(action.text, 'text'))
    case 'submit':
      return driver.submit(need(action.selector, 'selector'))
    case 'scroll':
      await driver.scrollOnce(action.px ?? 600)
      return undefined
    case 'exists':
      return driver.exists(need(action.selector, 'selector'))
    case 'setFiles': {
      // 找不到 / 不是文件输入框 / CDP 拒绝都由 driver 抛（各自一句），这里不把它们压成 false：
      // 三种失败的下一步不一样，`not-found` 那个字只留给"选择器没命中"之外的动作。
      if (!driver.setFiles) throw new Error('该 driver 不支持 setFiles（只有能说 CDP 的浏览器 driver 有）')
      const paths = action.paths ?? []
      if (!paths.length) throw new Error('setFiles 动作缺 paths（本地文件路径，按浏览器所在机器解释）')
      return driver.setFiles(need(action.selector, 'selector'), paths)
    }
    case 'open':
      // `kind:'open'` 的输入是 URL、输出才是 tabId——它由各宿主自己的「开一张标签」那一格接掉，
      // 永远到不了这里。留一句实话，别让它退化成一个静默的空动作。
      throw new Error(`open 不经过 act 执行路径（由宿主的 open 那一格接手）`)
    default: {
      // look/evaluate：页内求值。`evalJson` 声明为可选（别的 driver 可以不提供），守卫只为
      // 让类型说实话——真造出来的 driver 都有。
      const expr = need(action.expression, 'expression')
      if (!driver.evalJson) throw new Error('该 driver 不支持页内求值')
      return driver.evalJson(expr)
    }
  }
}

/** 默认确认窗口：动作完成后最多等这么久让预期特征出现，出现即返回。 */
export const EXPECT_DEADLINE_MS = 3000
const EXPECT_POLL_MS = 150

/** 一次动作的成败。**`done` 不是"成功"，是"没让确认，所以不假装确认"。** */
export type ActStatus = 'confirmed' | 'acted-unconfirmed' | 'done' | 'not-found'

/**
 * 动作 + observe —— 这是 action→observe 的落点，所有 transport / 宿主共用一份。
 *
 * 执行动作；若动作声明了 `expect` 特征，就轮询它出现（`driver.exists`），出现即 `confirmed`、
 * 到 deadline 没出现即 `acted-unconfirmed`；没声明就是 `done`。**关键是它给出诚实的成败**：
 * 点完直接返 done 只是「click 调用返回了」，不是「点成功了」，调用方判断不了。
 *
 * 点击本身的 actionability 超时收在 driver 里（有界等待 + 吞掉超时）——所以点不动不再傻等，
 * 而是快速回来、由这里的 confirm 说清到底成没成。
 *
 * click/type/submit 报告「选择器没命中任何元素」时直接返回 `not-found`，且**不再跑 expect
 * 轮询**——连目标都没找到，不是「点着了但页面没反应」那种有歧义的情形，等再久也不会自己变
 * 出一个从没存在过的元素；`expect` 回答的是另一个问题（动作生效了吗），两者不该共用一个字。
 */
export async function actWithConfirm(
  driver: PageDriver,
  action: ActionSpec,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): Promise<{ status: ActStatus; result: unknown }> {
  const result = await runAction(driver, action)
  if (SELECTOR_TARGETED.has(action.kind) && result === false) {
    return { status: 'not-found', result }
  }
  if (!action.expect) return { status: 'done', result }
  // 同一个等待原语,recipe 的 step.expect 也走它——这里本来有一份一模一样的私有 waitForFeature。
  const ok = await waitForSelector(driver, action.expect, {
    timeout: opts.deadlineMs ?? EXPECT_DEADLINE_MS,
    pollMs: opts.pollMs ?? EXPECT_POLL_MS,
  })
  return { status: ok ? 'confirmed' : 'acted-unconfirmed', result }
}
