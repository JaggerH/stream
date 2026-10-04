import { getPath, substitute } from './interpret.ts'
import type { RecipeAction, ActionFeature, DomFieldSpec, LoginCheck, LoginState, StepExpect, StepSettle } from './recipe.ts'
import type { PageDriver as BasePageDriver } from '../../shared/browser-relay/page-driver.ts'
import {
  EXPECT_DEFAULT_MS,
  EXPECT_POLL_MS,
  waitForSelector,
  type ScrollGeometry,
} from '../../shared/browser-relay/page-driver.ts'

// 翻译层那几样从共享库原样转出去：这个文件是采集侧的老门面，几十处 import 冲着它来，
// 转一手比让每个调用方各自改 import 路径便宜，也让「driver 的东西在这儿」这条直觉继续成立。
export { EXPECT_DEFAULT_MS, waitForSelector }
export type { ScrollGeometry }

/** within this many px of the content bottom counts as "at the loaded bottom" (SPA feeds
 *  rarely let you land exactly on scrollHeight; the last row's slack varies) */
const AT_BOTTOM_SLACK_PX = 64;
/** a scrollY delta below this = the scroll didn't actually move the page */
const MIN_SCROLL_MOVE_PX = 8;
/** consecutive no-move scrolls (while not at bottom) before we call the page stuck */
const STUCK_SCROLL_LIMIT = 4;

/**
 * 采集用的 driver —— **在翻译层（`BasePageDriver`）之上加回编排层的词汇**：卡片、信息流第 N
 * 条、字段表、身份。这几格认识 recipe 的概念，所以它们留在后端，不进 `shared/browser-relay/`
 * （插件宿主没有 recipe，把它们搬过去就要连 `dom-harvest` / `card-id` 一起拖进插件的 bundle）。
 *
 * **加一格之前先问它属于哪一层**：只认选择器、像素和 URL → 加进 `shared/browser-relay/
 * page-driver.ts`，两个宿主一起得到；认识卡片 / 字段 / recipe → 加在这里。这条线搞错的代价
 * 有先例：整层被复制过一遍，两份拷贝随后静默分家（见 `shared/browser-relay/page-driver.ts`
 * 的头注）。
 */
export interface PageDriver extends BasePageDriver {
  openItem(selector: string, index: number): Promise<void> // click the Nth match, new page/detail
  /** trusted click of a selector whose href contains a call-time identity */
  openTarget?(selector: string, identity: string): Promise<boolean>
  /** read the currently-rendered feed cards (DOM harvest); optional — XHR drivers omit it */
  readItems?(itemSelector: string, fields: Record<string, DomFieldSpec>): Promise<Record<string, string>[]>
  /** read a server-rendered array off `window` by dot-path (SSR-state harvest); optional */
  readState?(statePath: string): Promise<unknown>
  /** the feed cards rendered in the viewport RIGHT NOW (virtualized lists render only ~a
   *  screenful) with their note id + geometry — the closed-loop locator's "eyes". Optional;
   *  only the cloak/ext drivers implement it. */
  readViewport?(selector: string): Promise<ViewportCard[]>
  /** Where one specific card sits in the document RIGHT NOW — READ, not estimated. Off-screen
   *  cards of a loaded feed are usually still in the DOM, so this answers "scroll to exactly
   *  here" in one query. Null = the card isn't in the DOM at all. Optional. */
  findCard?(selector: string, identity: string): Promise<CardPosition | null>
}

/** A card's absolute position, plus the scroll state it was measured against (all CSS px). */
export interface CardPosition {
  docY: number      // the card's top in document coordinates
  scrollY: number
  viewportH: number
}

/** One rendered feed card: its note id (from the /explore/<id> href) and viewport-relative
 *  geometry (CSS px). Used by locateCard to see who's on screen and where. */
export interface ViewportCard {
  id: string
  top: number
  height: number
}

export interface LocateOpts { maxSteps?: number; dwellMs?: number; trace?: (line: string) => void }

/** A masonry row is ~4-5 cards wide, so cards whose ledger indices span less than this are all in
 *  ONE row: their docY differences are column stagger, not travel. A slope fitted from them is noise. */
const MIN_FIT_SPAN = 5;
/** below this the move isn't worth issuing (and a near-zero estimate would spin the loop) */
const MIN_LOCATE_MOVE_PX = 60;
/** consecutive blank viewport reads (the virtual list mid-re-render) tolerated before we accept
 *  that the page simply isn't a feed */
const BLANK_READ_LIMIT = 4;

/** Least-squares "ledger index → document Y" line over the cards we can currently SEE, or null when
 *  they can't support one (one row's worth of indices, or a non-positive slope). Fitting beats any
 *  fixed card-height guess: it measures THIS feed's real density (column count, card heights, ad
 *  rows) at THIS scroll position, and it's re-fitted after every move, so an off estimate corrects
 *  itself on the next pass instead of compounding. */
function fitIndexToY(refs: Array<{ i: number; y: number }>): ((index: number) => number) | null {
  if (refs.length < 2) return null
  const xs = refs.map((r) => r.i)
  if (Math.max(...xs) - Math.min(...xs) < MIN_FIT_SPAN) return null
  const n = refs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = refs.reduce((a, r) => a + r.y, 0) / n
  let num = 0
  let den = 0
  for (const r of refs) { num += (r.i - mx) * (r.y - my); den += (r.i - mx) ** 2 }
  if (den === 0) return null
  const slope = num / den
  if (slope <= 0) return null // ledger order and DOM order disagree — don't trust the estimate
  const intercept = my - slope * mx
  return (index) => intercept + slope * index
}

/** Bring the target card into view so it can be clicked. Look → move → look again, and every pass
 *  re-measures, so a bad move is corrected instead of compounded.
 *
 *  The move comes from the best information available, in this order:
 *
 *  1. READ IT. A loaded feed keeps its off-screen cards in the DOM, so the target's anchor is
 *     usually right there with a real bounding box — one query gives its exact document Y and we go
 *     straight to it. No ledger, no estimate. This is the normal path.
 *  2. ESTIMATE IT. The card isn't in the DOM (not loaded yet). Fit "ledger index → document Y" over
 *     the cards we CAN see and recognise, and extrapolate where the target must be.
 *  3. SKIM. Nothing on screen is in the ledger (a stale feed, e.g. xhs re-fetches 推荐 on a
 *     back-nav) — re-anchor at the top once and step down a screen at a time.
 *
 *  Farther than one screen we `scrollTo` outright: past human scroll speed there's nothing left to
 *  imitate, and the browse-task spec sanctions the jump. Within a screen we use a real trusted
 *  wheel, so the gesture immediately before the click still reads as a person.
 *
 *  The dwell after each move is NOT optional: the feed re-renders asynchronously, so reading the
 *  viewport immediately after a move returns the OLD cards — which looks like "we didn't move". */
export async function locateCard(
  driver: PageDriver, selector: string, orderedIds: string[], targetId: string, opts: LocateOpts = {},
): Promise<boolean> {
  if (!driver.readViewport) return false
  const targetIdx = orderedIds.indexOf(targetId)
  const maxSteps = opts.maxSteps ?? 12
  const dwellMs = opts.dwellMs ?? 250
  const ledger = new Map(orderedIds.map((id, i) => [id, i] as const))
  let prevSig = ''
  let reAnchored = false
  let blankReads = 0
  let jumps = 0
  let wheels = 0

  /** go to `want` (a document Y): a jump when it's farther than a screen, a trusted wheel when not */
  const moveTo = async (want: number, scrollY: number, viewportH: number, maxY: number | null): Promise<void> => {
    const target = Math.max(0, maxY == null ? want : Math.min(want, maxY))
    const delta = target - scrollY
    if (Math.abs(delta) > viewportH && driver.evalJson) {
      jumps++
      await driver.evalJson(`window.scrollTo(0, ${Math.round(target)})`)
    } else {
      wheels++
      await driver.scrollOnce(Math.round(Math.abs(delta) < MIN_LOCATE_MOVE_PX ? Math.sign(delta) * MIN_LOCATE_MOVE_PX : delta))
    }
    await driver.sleep(dwellMs)
  }

  for (let step = 0; step < maxSteps; step++) {
    const vp = await driver.readViewport(selector)
    if (vp.some((c) => c.id === targetId)) {
      opts.trace?.(`locate: found idx=${targetIdx} after ${jumps} jump(s) + ${wheels} wheel(s)`)
      return true
    }

    const geom = driver.scrollProbe ? await driver.scrollProbe() : null
    const viewportH = geom?.viewportH || 700
    const scrollY = geom?.scrollY ?? 0
    const maxY = geom ? Math.max(0, geom.scrollHeight - viewportH) : null
    // land the target ~a third of a screen below the fold — comfortably inside the viewport
    const landing = (docY: number) => Math.max(0, docY - viewportH / 3)

    if (vp.length === 0) {
      // NOT a verdict: the feed unmounts its cards while it re-renders, so a blank read just means
      // "nothing painted yet" — right after a big move, and for a beat after a harvest. Wait it out.
      // Only a page that STAYS blank isn't a feed at all.
      if (++blankReads > BLANK_READ_LIMIT) break
      await driver.sleep(dwellMs)
      continue
    }
    blankReads = 0

    const sig = `${scrollY}|${vp.map((c) => c.id).join(',')}`
    if (sig === prevSig) break // the page didn't move under our last move — stop, don't spin
    prevSig = sig

    // (1) the card itself, if the DOM still holds it — exact, and independent of the ledger
    const at = driver.findCard ? await driver.findCard(selector, targetId) : null
    if (at) {
      opts.trace?.(`locate: step=${step} y=${scrollY} vp=${vp.length} inDom docY=${at.docY}`)
      await moveTo(landing(at.docY), at.scrollY, at.viewportH || viewportH, maxY)
      continue
    }

    const refs = vp
      .map((c) => ({ i: ledger.get(c.id) ?? -1, y: scrollY + c.top }))
      .filter((r) => r.i >= 0)
    opts.trace?.(`locate: step=${step} y=${scrollY} vp=${vp.length} known=${refs.length}`)

    if (refs.length === 0) {
      // (3) cards ARE rendered but not one is ours — a stale/other feed, no reference to measure
      // from. Re-anchor at the top once and skim down; if the top is just as foreign, give up.
      if (!reAnchored && driver.evalJson) {
        reAnchored = true
        jumps++
        await driver.evalJson('window.scrollTo(0, 0)')
        await driver.sleep(dwellMs)
      } else {
        await moveTo(scrollY + viewportH, scrollY, viewportH, maxY)
      }
      continue
    }
    if (targetIdx < 0) break // not in the ledger and not in the DOM — nothing left to aim at

    // (2) not in the DOM yet — extrapolate from the cards we can see
    const yOf = fitIndexToY(refs)
    if (yOf) {
      await moveTo(landing(yOf(targetIdx)), scrollY, viewportH, maxY)
    } else {
      const nearest = refs.reduce((a, b) => (Math.abs(b.i - targetIdx) < Math.abs(a.i - targetIdx) ? b : a))
      const dir = targetIdx > nearest.i ? 1 : -1 // no usable fit: one screen toward it
      await moveTo(scrollY + dir * viewportH * 0.8, scrollY, viewportH, maxY)
    }
  }

  const vp = await driver.readViewport(selector)
  const hit = vp.some((c) => c.id === targetId)
  opts.trace?.(`locate: ${hit ? 'found' : 'MISS'} idx=${targetIdx} after ${jumps} jump(s) + ${wheels} wheel(s)`)
  return hit
}

export interface RandomSource {
  int(min: number, max: number): number
}

export function makeRandom(seed: number): RandomSource {
  let state = seed || 1;
  return {
    int(min: number, max: number): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const unsigned = state >>> 0;
      return min + (unsigned % (max - min + 1));
    }
  };
}

/** Per-scroll breakdown of a scroll step — where the (usually dominant) scroll wall-clock
 *  went. `sizeCurve[i]` is the cumulative harvested count after scroll i, so a long tail
 *  (e.g. 90 items by scroll 12, last 10 over 8 more scrolls) is visible at a glance. */
export interface ScrollStats {
  scrolls: number        // total scroll actions issued
  dwellMs: number        // total time spent in post-scroll dwell (the bulk of the cost)
  atBottomRounds: number // rounds spent at the loaded bottom waiting for a new batch
  sizeCurve: number[]    // cumulative harvest count after each scroll
  stopReason: string     // why the loop ended (target reached / reached end / max times)
}

export interface ActionTrace {
  step: number
  kind: RecipeAction['kind']
  draws: number[]
  note?: string
  /** present only for a scroll step (geometry loop) — see ScrollStats */
  scroll?: ScrollStats
}

export class RecipeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeGuardError';
  }
}

export class FeatureDriftError extends Error {
  constructor(readonly step: number, readonly feature: ActionFeature) {
    super(`Feature drift at step ${step}: selector "${feature.selector}" not found`);
    this.name = 'FeatureDriftError';
  }
}

/** Thrown when scrolls stop moving the page while it is NOT yet at the bottom of loaded
 *  content — the scroll is landing on nothing (overlay, wrong scroll container, a modal).
 *  Surfaced instead of silently returning a short harvest: the recipe/page needs a look. */
export class ScrollStuckError extends Error {
  constructor(attempts: number) {
    super(`scroll made no progress after ${attempts} attempts — page not scrolling (overlay / wrong container?)`);
    this.name = 'ScrollStuckError';
  }
}

/** Thrown when a login/verify wall appears mid-run; unwinds the scroll loop so the
 *  outcome is classified as needsLogin, never as drift. */
export class WalledError extends Error {
  constructor() {
    super('login wall detected mid-run');
    this.name = 'WalledError';
  }
}

/** 站方的风控挑战（验证码遮罩之类）在跑到一半时出现。和 `WalledError` 分开，因为下游的
 *  处置相反：墙 → 让用户去登录；挑战 → 谁都不用动，等 facility 冷却。**两者都绝不能记 drift**。 */
export class ChallengedError extends Error {
  constructor() {
    super('site challenge (risk control) detected mid-run');
    this.name = 'ChallengedError';
  }
}

/**
 * Classify the session from the recipe's two login signals.
 * Wall wins: a positive wall signal means blocked regardless of anything else.
 * Then a positive logged-in signal means authenticated; neither means UNKNOWN
 * (treated as needs-login at entry — we never harvest an unproven session).
 */
/**
 * 三态登录判定。**只有判不出来时才付重试的钱**：命中任一判据当场返回，健康路径一分不多花。
 *
 * 为什么要重试（2026-07-29 活体）：探针里出现过 `login 3ms` —— 页面刚导航完、登录弹窗还没
 * 渲染出来的那一刻，`.login-modal` 和 `.user` **两个都不在**，于是判成 UNKNOWN，recipe 照常
 * 往下跑，在一个只有登录墙的页面上白滚二十轮。UNKNOWN 在这里的真实含义大多是"还没画出来"，
 * 不是"这页没有登录概念"，所以再看一眼比当场定案便宜得多。
 *
 * 只重试一次、只等 500ms：这是给一次异步渲染的余量，不是在这儿轮询等登录完成（那是 QR
 * provider 的活）。判不出来仍然返回 UNKNOWN —— 上层据此决定是继续还是当作没登录。
 */
const LOGIN_RECHECK_MS = 500

export async function detectLoginState(driver: PageDriver, loginCheck: LoginCheck): Promise<LoginState> {
  const once = async (): Promise<LoginState> => {
    // 挑战排在墙**前面**：一张验证码遮罩底下常常还压着站点自己的登录入口，先问墙就会把
    // "站方让我们等"读成"你得去登录"——两者对用户的动作要求相反，读反了就是把人支去白折腾。
    if (loginCheck.challenge && await driver.exists(loginCheck.challenge)) return 'CHALLENGED';
    if (await driver.exists(loginCheck.wall)) return 'WALLED';
    if (await driver.exists(loginCheck.loggedIn)) return 'LOGGED_IN';
    return 'UNKNOWN';
  }
  const first = await once()
  if (first !== 'UNKNOWN') return first
  await driver.sleep(LOGIN_RECHECK_MS)
  return once()
}

/**
 * The **observe** half of opening a note: after a (humanized) trusted click, poll until the tab's
 * URL carries `identity` — i.e. the note actually opened (xhs pushState's to /explore/<id>) — or
 * the deadline passes. Split out from the click on purpose: the click's cost is humanize's
 * human-like cursor travel (deliberate, anti-detection), and this is the separate "waited for the
 * page to change" cost — the two are different things and the probe should report them apart.
 *
 * A driver that can't report its URL (`currentUrl` absent) can't be observed, so we optimistically
 * treat the dispatched click as opened rather than blocking.
 */
export async function observeOpened(driver: PageDriver, identity: string, deadlineMs = 3000, pollMs = 150): Promise<boolean> {
  if (!driver.currentUrl) return true;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if ((await driver.currentUrl()).includes(identity)) return true;
    if (Date.now() >= deadline) return false;
    await driver.sleep(pollMs);
  }
}

/** 步骤 `expect` 的默认上限。够一次异步渲染，不够一次人机挑战——挑战那步要自己调大。 */
// `waitForSelector` / `EXPECT_DEFAULT_MS` 住在 `shared/browser-relay/page-driver.ts`（本文件
// 顶部转出）。它是这个代码库里"等某选择器达到某状态"的**唯一实现**：`cdp_act` 的 expect、
// `runActions` 里动作步骤的 `step.expect`、recipe-runner 里 `locate`/`openTarget` 的闸门、
// 以及插件宿主的 act 确认，四条路径共用那一份。**别再写第五份。**
//
// `observeOpened`（就在上面）不是它的重复：那一份判的是 **URL 带不带 identity**，是
// locate/openTarget 的内建确认（"打开了没"），和"某个选择器在不在"是两件事。

/** `settle` 的默认上限。 */
export const SETTLE_DEFAULT_MS = 15_000

/**
 * 等某块区域**画完并停住**。见 `StepSettle` —— 判据是"变过了 + 停住了"，逐帧比 JPEG 字节，
 * 不解码、不存参考图、不联网。返回观测到的状态，让调用方能把它如实写进 trace。
 *
 * `driver.shotOf` 缺席（某些 driver 没有截图能力）时返回 `unsupported`：**不假装等过了**。
 */
export async function waitForSettle(
  driver: PageDriver,
  s: StepSettle,
): Promise<{ state: 'settled' | 'timeout' | 'unsupported' | 'absent'; frames: number; ms: number }> {
  const t0 = Date.now()
  if (!driver.shotOf) return { state: 'unsupported', frames: 0, ms: 0 }
  const need = s.stableFrames ?? 3
  const every = s.intervalMs ?? 250
  const deadline = t0 + (s.timeout ?? SETTLE_DEFAULT_MS)
  // 先等到它**有盒子**再立基线。元素刚挂上 DOM 的那一瞬 rect 还是 0×0（布局没算完），
  // 而 `shotOf` 对零尺寸返回 null —— 把它当成"元素不在"直接放弃，就等于没等：实测
  // step#0 的 expect 一满足就进到这里，3ms 后拿到 null，闸门形同虚设，又是早点。
  let baseline: string | null = null
  let framesBefore = 0
  for (;;) {
    baseline = await driver.shotOf(s.selector)
    framesBefore++
    if (baseline != null) break
    if (Date.now() >= deadline) return { state: 'absent', frames: framesBefore, ms: Date.now() - t0 }
    await driver.sleep(s.intervalMs ?? 250)
  }
  let last = baseline
  let same = 0
  let frames = framesBefore
  for (;;) {
    await driver.sleep(every)
    const shot = await driver.shotOf(s.selector)
    frames++
    if (shot == null) {
      // 元素没了 —— 也是"事情发生完了"的一种，别在这儿空转到超时
      return { state: 'settled', frames, ms: Date.now() - t0 }
    }
    same = shot === last ? same + 1 : 0
    last = shot
    // 默认必须**同时**满足"和基线不一样"和"连着几帧没动"：只要"没动"会在还没开始画的时候
    // 立刻满足（那时它一直是空的、一直没动），等于没等。
    //
    // `alreadyStable` 显式放宽掉前一半——变化由**上一步**触发、而上一步比那次重绘还慢时，
    // 基线取到的就是终态，"变过了"永远不会成立，于是必然空等到 timeout 再放行（静默，
    // 见 StepSettle.alreadyStable 头注记的那次 15 秒）。
    if ((s.alreadyStable || shot !== baseline) && same >= need - 1) {
      return { state: 'settled', frames, ms: Date.now() - t0 }
    }
    if (Date.now() >= deadline) return { state: 'timeout', frames, ms: Date.now() - t0 }
  }
}

/**
 * 读一个选择器命中的所有元素的可见文本（去空、截断）。`errorSurface` 采样用。
 *
 * 不抛：报错面读不到只是少一行诊断，不该把它变成这一步的失败原因（那会把"站点为什么拒绝"
 * 换成"我读报错面失败了"，比原来更糟）。
 */
async function readTexts(driver: PageDriver, selector: string): Promise<string[]> {
  if (!driver.evalJson) return []
  const out = await driver
    .evalJson(
      `(()=>{const o=[];for(const el of document.querySelectorAll(${JSON.stringify(selector)})){` +
        `const t=(el.innerText||el.textContent||'').trim();if(t)o.push(t.slice(0,200))}return o})()`,
    )
    .catch(() => [])
  return Array.isArray(out) ? out.filter((t): t is string => typeof t === 'string' && t.length > 0) : []
}

/**
 * 数一个选择器现在命中几个。`countIncreases` 判据的量尺。
 *
 * 走 `evalJson` 而不是 `exists`：`exists` 只答"有没有"，答不了"有几个" —— 而"多了一行"这件事
 * 恰恰只有计数说得清（有没有从来都是"有"）。driver 不支持页内求值时返回 -1，让上层当"数不出来"
 * 处理，而不是悄悄按 0 算（那会把"数不出来"伪装成"一行都没有"）。
 */
async function countMatches(driver: PageDriver, selector: string): Promise<number> {
  if (!driver.evalJson) return -1
  const n = await driver
    .evalJson(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
    .catch(() => -1)
  return typeof n === 'number' && Number.isFinite(n) ? n : -1
}

/** 一个步骤声明了 `expect`，但它在上限内没发生 —— 因果链在这里断了，后面全是噪声。 */
export class StepExpectError extends Error {
  constructor(
    readonly step: number,
    readonly expect: StepExpect,
    readonly attempts = 1,
    readonly note?: string,
    /** `countIncreases` 判据的前后读数，以及等待期间站点自己喊出来的报错。 */
    readonly evidence?: { countBefore?: number; countAfter?: number; siteErrors?: string[] },
  ) {
    super(
      `step#${step} expect 未满足：` +
        // 判据说的必须是**它实际量的那件事**。countIncreases 量的是数量，报"没有出现"是错的描述:
        // 那个选择器一直都在（本来就命中着旧的那些），读者会去查一个根本不存在的"元素没渲染"。
        (expect.countIncreases
          ? `${expect.selector} 的命中数在 ${expect.timeout ?? EXPECT_DEFAULT_MS}ms 内没有变多（${
              evidence?.countBefore ?? '?'
            }→${evidence?.countAfter ?? '?'}）`
          : `${expect.selector} 在 ${expect.timeout ?? EXPECT_DEFAULT_MS}ms 内没有${
              expect.state === 'gone' ? '消失' : '出现'
            }`) +
        `${attempts > 1 ? `（动作重做了 ${attempts} 次）` : ''}` +
        // 站点自己的说法优先级最高：它常常一句话就结案（"名称重复"），而这句话活不过几秒，
        // 等失败被确认时早没了。没有声明 errorSurface 时这里什么都不加。
        (evidence?.siteErrors?.length
          ? `【站点报错：${evidence.siteErrors.join(' / ')}】`
          : expect.errorSurface
            ? `【站点报错：等待期间 "${expect.errorSurface}" 一条都没出现 —— 动作可能根本没抵达】`
            : '') +
        // 失败步骤的 trace 拿不到（抛异常时 runActions 的返回值整个丢掉），而这一步自己观测到的
        // 东西（settle 等了多久、点没点着）恰恰是判断"到底哪儿断了"最需要的一行。
        (note ? `【本步观测：${note}】` : ''),
    )
    this.name = 'StepExpectError'
  }
}

/**
 * 一个步骤**做成了，但拿回来的结果不合格**（今天只有 `call` 的 `match`）。
 *
 * 和 `StepExpectError` 分开，是因为这条代码自己立的规矩：判据说的必须是它实际量的那件事。
 * 硬套 expect 的措辞会拼出"某选择器没出现"这种假话，而真相是"识别器吐了个不合法的结果"。
 *
 * 与它相同的一点：**都能被 `expect.retryFrom` 那条整段重来的路接住**（见 recipe-runner
 * 的步骤循环）。所以它不是 `RecipeGuardError`——那一档是硬失败，不给重来的机会。
 */
export class StepResultError extends Error {
  constructor(readonly step: number, reason: string) {
    super(`step#${step} 结果不合格：${reason}`)
    this.name = 'StepResultError'
  }
}

/**
 * 一个步骤的 `expect` 在**动作之前**就已经成立 —— 它是恒真的，永远不会失败，所以它是装饰不是判据。
 *
 * 这不是"可能有问题"，是**这一步从此没有监督**：动作没生效也照样判过，失败会在两步之外以一副
 * 无关的面孔出现（活体：zhipu-create-key 四步全绿、key 根本没建出来，最后报的是"抽取命中 0 处"）。
 * 所以断在动手**之前** —— 判据都不成立，就别再去改页面状态了。
 */
export class StepExpectVacuousError extends Error {
  constructor(readonly step: number, readonly expect: StepExpect) {
    super(
      `step#${step} expect 恒真：动作前 "${expect.selector}" 就已经${expect.state === 'gone' ? '不在' : '在'}了，` +
        `这个判据区分不了"动作生效了"和"动作没生效"。改成一个动作前为假的判据` +
        `（列表多一行这类用 countIncreases），或者确实无害就显式写 alreadyThere:true。`,
    )
    this.name = 'StepExpectVacuousError'
  }
}

export interface HarvestProgress {
  done: boolean
  size: number
}

export async function runActions(
  actions: RecipeAction[],
  driver: PageDriver,
  rnd: RandomSource,
  harvest: HarvestProgress,
  opts: {
    cookieDomain: string
    params?: Record<string, string>
    entryWait?: string
    /** pulled after each scroll tick (DOM harvest reads the rendered cards here);
     *  undefined for XHR harvest, whose accumulator is fed by the response listener */
    onTick?: () => Promise<void>
    /** 这批动作在整份 recipe 里的起始下标。RecipeRunner **一步一调**，本地下标恒为 0，
     *  报错里那个 step# 就永远是 0 —— 指向错的步骤比不指更糟。 */
    stepIndex?: number
    /**
     * `call` 步骤的出口。**由宿主注入，recipe 自己给不出目的地**——这是那一格第 1 条边界
     * 的落点：`service` 是一个名字，只有宿主知道它解析到哪个后端（`/_p/<service>`），
     * 解析不到就抛。不注入 = 这份 recipe 里的 `call` 一步都跑不了（硬失败，不是静默跳过）。
     */
    call?: (
      service: string,
      path: string,
      body: { image: string } & Record<string, string | number | boolean>,
    ) => Promise<unknown>
    /**
     * 这份 recipe 在 `meta.effects` 里申报过的副作用。`call` 没申报就不许跑——
     * 申报是安装预览亮牌的依据，跑一件没亮过牌的事等于让那块牌白挂。
     */
    effects?: readonly string[]
  }
): Promise<ActionTrace[]> {
  const trace: ActionTrace[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    // Check feature drift if present
    if ('feature' in action && action.feature) {
      const exists = await driver.exists(action.feature.selector);
      if (!exists) {
        throw new FeatureDriftError(i, action.feature);
      }
    }

    const draws: number[] = [];
    let note: string | undefined;
    let scroll: ScrollStats | undefined;

    // 动作本体抽成一个闭包，是为了 `expect.retryEvery` 能把它重做一遍。见下面那段的理由。
    const perform = async (): Promise<void> => {
    switch (action.kind) {
      case 'goto': {
        const resolved = substitute(action.url, opts.params ?? {});
        let parsed: URL;
        try {
          parsed = new URL(resolved);
        } catch (err) {
          throw new RecipeGuardError(`Invalid URL: ${resolved}`);
        }
        const host = parsed.hostname;
        if (host !== opts.cookieDomain && !host.endsWith('.' + opts.cookieDomain)) {
          throw new RecipeGuardError(`URL host ${host} does not match cookie domain ${opts.cookieDomain}`);
        }
        await driver.goto(resolved, opts.entryWait);
        break;
      }

      case 'scroll': {
        // Already have what we came for before scrolling once — an entry observer can hand us the
        // whole SSR first batch the moment the page loads. Scrolling anyway would burn a dwell and
        // drag more feed into a session that didn't ask for it.
        if (harvest.done) {
          note = `scroll skipped: target already reached (${harvest.size})`;
          break;
        }

        let iteration = 0;
        let prevSize = harvest.size;

        // Geometry-driven control loop: keep scrolling until we reach the bottom of the
        // currently-loaded content (that's what triggers the site's next lazy-load batch),
        // and only declare "the end" once we're at that bottom AND nothing new loads. A flat
        // harvest while still ABOVE the bottom means "haven't scrolled far enough yet", never
        // "the end" — so it must NOT stop the loop. This is DOM-based, so the async XHR
        // harvest lagging a tick can't cause a false stop. General to home + search feeds.
        if (driver.scrollProbe) {
          let stallAtBottom = 0; // consecutive at-bottom rounds that loaded nothing new
          let stuckScroll = 0;   // consecutive scrolls that didn't move the page (not at bottom)
          let dwellMs = 0;       // total post-scroll dwell — the bulk of the scroll wall-clock
          let atBottomRounds = 0;
          const sizeCurve: number[] = []; // cumulative harvest count after each scroll
          // Baseline from the pre-scroll geometry so the FIRST round measures real growth /
          // movement against where we started (not against a sentinel that fakes progress).
          const first = await driver.scrollProbe();
          let prevScrollY = first.scrollY;
          let prevHeight = first.scrollHeight;

          while (true) {
            iteration++;
            const px = rnd.int(400, 1200);
            draws.push(px);
            const dwell = rnd.int(action.dwell_s[0], action.dwell_s[1]);
            draws.push(dwell);

            await driver.scrollOnce(px);
            await driver.sleep(dwell * 1000);
            dwellMs += dwell * 1000;
            if (opts.onTick) await opts.onTick();

            sizeCurve.push(harvest.size);
            if (harvest.done) {
              note = `scroll stop: target reached after ${iteration}`;
              break;
            }

            const geom = await driver.scrollProbe();
            const sizeNow = harvest.size;
            const grew = sizeNow > prevSize || geom.scrollHeight > prevHeight;
            const atBottom = geom.scrollY + geom.viewportH >= geom.scrollHeight - AT_BOTTOM_SLACK_PX;
            const moved = geom.scrollY - prevScrollY >= MIN_SCROLL_MOVE_PX;

            if (atBottom) {
              // At the loaded bottom — the moment a new batch should trigger. Count consecutive
              // bottoms that yield nothing new as the real end.
              atBottomRounds++;
              stuckScroll = 0;
              if (grew) stallAtBottom = 0;
              else if (++stallAtBottom >= action.noProgressStop) {
                note = `scroll stop: reached end after ${iteration}`;
                break;
              }
            } else {
              // Below the bottom: a flat round just means we haven't reached the load trigger.
              // Keep going. The only bail here is a scroll that isn't moving the page at all.
              stallAtBottom = 0;
              if (moved) stuckScroll = 0;
              else if (++stuckScroll >= STUCK_SCROLL_LIMIT) {
                throw new ScrollStuckError(iteration);
              }
            }

            prevSize = sizeNow;
            prevScrollY = geom.scrollY;
            prevHeight = geom.scrollHeight;
            if (iteration >= action.maxTimes) {
              note = `scroll stop: max times reached after ${iteration}`;
              break;
            }
          }
          scroll = { scrolls: iteration, dwellMs, atBottomRounds, sizeCurve, stopReason: note ?? '' };
          break;
        }

        // Fallback (driver can't report geometry): the legacy flat harvest-count stop.
        let noProgressCount = 0;
        while (true) {
          iteration++;
          const px = rnd.int(400, 1200);
          draws.push(px);
          const dwell = rnd.int(action.dwell_s[0], action.dwell_s[1]);
          draws.push(dwell);

          await driver.scrollOnce(px);
          await driver.sleep(dwell * 1000);
          if (opts.onTick) await opts.onTick();

          const currentSize = harvest.size;
          if (currentSize === prevSize) {
            noProgressCount++;
          } else {
            noProgressCount = 0;
          }
          prevSize = currentSize;

          if (harvest.done) {
            note = `scroll stop: target reached after ${iteration}`;
            break;
          }
          if (noProgressCount >= action.noProgressStop) {
            note = `scroll stop: no progress after ${iteration}`;
            break;
          }
          if (iteration >= action.maxTimes) {
            note = `scroll stop: max times reached after ${iteration}`;
            break;
          }

        }
        break;
      }

      case 'openItems': {
        const n = rnd.int(action.count[0], action.count[1]);
        draws.push(n);

        for (let j = 0; j < n; j++) {
          const index = rnd.int(0, 9);
          draws.push(index);
          const dwell = rnd.int(action.dwell_s[0], action.dwell_s[1]);
          draws.push(dwell);

          await driver.openItem(action.selector, index);
          await driver.sleep(dwell * 1000);
          if (action.back) {
            await driver.back();
          }
        }
        break;
      }

      case 'click': {
        // `synthetic` = 不发真鼠标，页内直接 `el.click()`（见 recipe.ts 那一格头注：可信点击
        // 是 11 次往返、每次等一帧，而后台标签没帧可等）。**驱动不支持页内求值就硬失败**，
        // 绝不悄悄退回可信点击——那会把一个已经声明"我要快"的步骤又变回 7–35 秒，而且没有
        // 任何一处会说它没生效。
        let hit: boolean;
        if (action.synthetic) {
          if (!driver.evalJson) {
            throw new RecipeGuardError(`click.synthetic 需要驱动支持页内求值（evalJson），当前驱动没有`);
          }
          hit = (await driver.evalJson(
            `(()=>{const el=document.querySelector(${JSON.stringify(action.selector)});` +
            `if(!el)return false;el.click();return true})()`,
          )) === true;
        } else {
          hit = await driver.click(action.selector, action.position);
        }
        // A click that found nothing is silent otherwise — the next step just fails somewhere
        // else with an unrelated symptom. Say it in the trace where it happened.
        const how = action.synthetic ? 'click(synthetic)' : 'click';
        const said = hit ? `${how} ok: ${action.selector}` : `${how} missed: no element matches ${action.selector}`;
        note = note ? `${note}; ${said}` : said;
        break;
      }

      case 'type': {
        const resolvedText = substitute(action.text, opts.params ?? {});
        const hit = await driver.type(action.selector, resolvedText);
        // Same fact as the click branch above: a type into nothing must not read as silent success.
        const said = hit ? `type ok: ${action.selector}` : `type missed: no element matches ${action.selector}`;
        note = note ? `${note}; ${said}` : said;
        break;
      }

      case 'submit': {
        const hit = await driver.submit(action.selector);
        const said = hit ? `submit ok: ${action.selector}` : `submit missed: no element matches ${action.selector}`;
        note = note ? `${note}; ${said}` : said;
        break;
      }

      case 'setFiles': {
        // 路径按换行拼（`format:'path', multiple:true` 参数翻译后的形状）。空 = 这一轮没给本地文件，
        // 跳过但要在 trace 里说：同一份 recipe 常同时收本地文件和小图 data URL 两种入口。
        // `substitute` 对参数袋里没有的洞**原样保留**（`{files}` 就是字符串 "{files}"）——交给 CDP 就是一条
        // 不存在的路径，而 DOM.setFileInputFiles 对不存在的路径不报错、页面拿到 0 字节的 File。所以没填上的洞
        // 一律当"没给"，跳过并写进 trace。
        const raw = substitute(action.paths, opts.params ?? {});
        const paths = raw.split('\n').map((p) => p.trim()).filter((p) => p && !/^\{\w+\}$/.test(p));
        let said: string;
        if (paths.length === 0) {
          said = `setFiles skipped: no paths (${action.selector}${/\{\w+\}/.test(raw) ? `, ${raw.trim()} 没填上` : ''})`;
        } else {
          if (!driver.setFiles) throw new Error(`step#${(opts.stepIndex ?? 0) + i} setFiles：这个 driver 说不了 CDP，放不进本地文件`);
          // driver 自己会抛：选择器没命中 / 不是 <input type=file> / CDP 拒（路径按浏览器那台机器解释）。
          const got = await driver.setFiles(action.selector, paths);
          said = `setFiles ok: ${got.length} file(s) into ${action.selector}: ${got.map((f) => `${f.name}(${f.size}B)`).join(', ')}`;
        }
        note = note ? `${note}; ${said}` : said;
        break;
      }

      case 'call': {
        // 边界 3：没在 meta.effects 里申报过就不许跑。安装预览按 effects 亮牌，跑一件没亮过牌
        // 的事等于让那块牌白挂——而这一格送出去的是用户屏幕上的东西。
        if (!opts.effects?.includes('send')) {
          throw new RecipeGuardError(
            `call 步骤要求 meta.effects 里申报 "send"（这条 recipe 会把页面上某个元素的截图发给服务 ${action.service}）`
          );
        }
        // 边界 1：目的地由宿主解析。没注入出口 = 硬失败，不是静默跳过——静默跳过会让后面那步
        // 拿着一个没绑上的 {hole} 去填表，而那看起来像"识别错了"。
        if (!opts.call) {
          throw new RecipeGuardError(`call 步骤没有可用的出口（宿主未注入出口），service=${action.service}`);
        }
        if (!action.path.startsWith('/') || action.path.includes('//')) {
          throw new RecipeGuardError(`call.path 必须是以 / 开头的路径，拿到的是 ${action.path}`);
        }
        // 边界 2：只送"某个元素那一块的截图"。驱动不支持这个能力就直说，别退化成整页截图——
        // 整页正是这一格刻意不给的东西。
        if (!driver.shotOf) {
          throw new RecipeGuardError('call 需要驱动支持 shotOf（只截一个元素），当前驱动没有');
        }
        const image = await driver.shotOf(action.input.shotOf);
        if (image === null) {
          throw new RecipeGuardError(`call 取不到截图：没有元素匹配 ${action.input.shotOf}`);
        }
        // `options` 是 recipe 里写死的字面量，**不做 `{param}` 插值**——参数袋里装着宿主注入
        // 的凭据，能引用它就是一条外泄路。装载期还有一道闸把带 `{…}` 的值直接拒掉
        // （`validateCallOptions`），这里只负责原样并进去；`image` 永远压在最后，选项盖不掉它。
        const answer = await opts.call(action.service, action.path, { ...action.options, image });
        const picked = getPath(answer, action.from);
        if (picked === undefined || picked === null || picked === '') {
          throw new RecipeGuardError(
            `call 回来的东西里没有 "${action.from}"（service=${action.service}${action.path}）——` +
            `绑不上就必须停，否则后面那步会拿一个没填的 {${action.bind}} 去操作页面`
          );
        }
        const value = String(picked);
        // 形状闸：不合法的结果**绝不往下走**。理由见 recipe.ts 那一格的头注——把一个明显
        // 不合法的 OCR 结果填进去提交，是拿用户的账号去试一次注定失败的登录，而"连续失败
        // 登录"在券商那边是有后果的。抛 StepExpectError 而不是 GuardError：它要能被
        // `expect.retryFrom` 那条整段重来的路接住（刷新那张图再认一次），GuardError 是硬失败。
        if (action.match !== undefined && !new RegExp(action.match).test(value)) {
          throw new StepResultError(
            (opts.stepIndex ?? 0) + i,
            `call 回来的 "${action.from}" 不满足 match=${action.match}（拿到 ${value.length} 个字符）`,
          );
        }
        // 写进本次运行的参数袋。它是逐步传下去的同一个对象，所以后面的 {bind} 看得到；
        // 全词汇表里只有这一格会往里写，见 recipe.ts 那一格的头注。
        if (opts.params) opts.params[action.bind] = value;
        // **追加，不是赋值**——和 click/type/submit 一致。直接赋值会把前面那行
        // `settle …` 覆盖掉，而 settle 的结果正是这一步最值钱的一条证据：它可以静静地
        // 等满 15 秒再放行（`timeout` 不致命），而那 15 秒会被折进本步的耗时里，看起来
        // 像"识别很慢"。活体（2026-09-03）就是这么丢的：两次运行 step#1 都是 15.0s+，
        // 而识别本身实测 10ms。
        {
          const said = `call ${action.service}${action.path} → {${action.bind}}`;
          note = note ? `${note}; ${said}` : said;
        }
        break;
      }
    }
    };

    // 闸门在动作之前：有些目标在"画完"之前接不住手势，早点下去不是白点，是把它打坏。
    if (action.settle) {
      const st = await waitForSettle(driver, action.settle);
      note = `settle ${st.state} ${st.ms}ms/${st.frames}帧`;
    }

    // 判据的**区分力**闸门，也在动作之前：动作前就成立的 expect 恒真，等于这一步没有监督。
    // 读一次即时状态，不等待 —— 这里问的是"现在是什么样"，不是"会不会变成那样"。
    let countBefore = 0;
    if (action.expect && !action.expect.alreadyThere) {
      const e = action.expect;
      if (e.countIncreases) {
        countBefore = await countMatches(driver, e.selector);
      } else if ((await driver.exists(e.selector)) !== (e.state === 'gone')) {
        throw new StepExpectVacuousError((opts.stepIndex ?? 0) + i, e);
      }
    }

    await perform();

    // 动作做完，等它引发的事发生。没发生就在这里断——因果链断了，后面的步骤只会以无关的
    // 症状失败（"submit 找不到"其实是"验证没过"），而报错要指到真正断掉的那一步。
    if (action.expect) {
      const expect = action.expect;
      const stepIndex = (opts.stepIndex ?? 0) + i;
      const deadline = Date.now() + (expect.timeout ?? EXPECT_DEFAULT_MS);
      let attempts = 1;
      let met = false;
      let countAfter = countBefore;
      // 站点自己的报错**必须在等待期间采**：toast 活 3 秒，判据上限 15 秒，等失败被确认时它早没了。
      const siteErrors: string[] = [];
      const sampleSiteErrors = async () => {
        if (!expect.errorSurface) return;
        for (const t of await readTexts(driver, expect.errorSurface)) {
          if (!siteErrors.includes(t)) siteErrors.push(t);
        }
      };
      for (;;) {
        const left = deadline - Date.now();
        const until = Date.now() + Math.max(0, expect.retryEvery ? Math.min(expect.retryEvery, left) : left);
        // 两种判据共用一个轮询循环，是为了让报错面的采样对两者都生效（早先 present 那支走
        // `waitForSelector`，它内部的等待里没有采样点，站点那句话就正好在那段里消失）。
        for (;;) {
          if (expect.countIncreases) {
            countAfter = await countMatches(driver, expect.selector);
            met = countAfter > countBefore;
          } else {
            met = (await driver.exists(expect.selector)) === (expect.state !== 'gone');
          }
          if (met) break;
          await sampleSiteErrors();
          if (Date.now() >= until) break;
          await driver.sleep(EXPECT_POLL_MS);
        }
        if (met || !expect.retryEvery || Date.now() >= deadline) break;
        // 重做，不是重试等待：目标还没准备好接收这个手势时，等再久也不会自己发生。
        await perform();
        attempts++;
      }
      if (!met) {
        throw new StepExpectError(stepIndex, expect, attempts, note, {
          ...(expect.countIncreases ? { countBefore, countAfter } : {}),
          siteErrors,
        });
      }
      const done = `expect ok: ${expect.selector}${expect.countIncreases ? ` ${countBefore}→${countAfter}` : ''}${attempts > 1 ? ` (第 ${attempts} 次动作后)` : ''}`;
      note = note ? `${note}; ${done}` : done;
    }

    trace.push({
      step: i,
      kind: action.kind,
      draws,
      ...(note ? { note } : {}),
      ...(scroll ? { scroll } : {})
    });
  }

  return trace;
}
