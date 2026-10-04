import type { SessionAuthSpec } from '../manifest/types.ts'
import type { LoginContext, LoginEvent, LoginProvider } from './login-provider.ts'
import type { LoginBrowser, LoginLock, LoginPage } from './login-page.ts'
export type { LoginBrowser, LoginLock, LoginPage } from './login-page.ts'

export interface BrowserQrDeps {
  browser: LoginBrowser
  lock: LoginLock
  onBefore?: (facility: string) => Promise<void>
  pollMs?: number
  timeoutMs?: number
  now?: () => number
}

export class BrowserQrLoginProvider implements LoginProvider {
  readonly method = 'qr' as const
  constructor(private readonly deps: BrowserQrDeps) {}

  async begin(spec: SessionAuthSpec, ctx: LoginContext, emit: (e: LoginEvent) => void, signal: AbortSignal): Promise<void> {
    // This provider drives an in-Stream QR scan; a cookie-injection facility has no scan flow
    // (its session comes from the broker), so it never reaches here.
    if (spec.login !== 'qr') { emit({ kind: 'failed', facility: spec.facility, reason: `facility "${spec.facility}" uses cookie-injection login, not QR` }); return }
    const pollMs = this.deps.pollMs ?? 2000
    const timeoutMs = this.deps.timeoutMs ?? 120_000
    const now = this.deps.now ?? Date.now
    await this.deps.onBefore?.(spec.facility)
    const lock = await this.deps.lock.acquire(spec.facility)
    let page: LoginPage | null = null
    try {
      page = await this.deps.browser.openProfile(spec.facility)
      await page.goto(spec.loginUrl)
      // **不抢屏。** 二维码是要送到 Stream 前端去给用户看的——把浏览器掀到他面前，等于让他
      // 在两个窗口之间来回跳，而他要看的那张图明明就在 Stream 里。
      //
      // **但截图这条腿本来就是脆的，别指望 focus 仿真替它兜底。** `Page.captureScreenshot`
      // 等的是合成器真产出一帧，而那由 OS 那层"这个 Chrome 窗口显不显示在屏幕上"说了算
      // （盖住/最小化/锁屏都算），`Emulation.setFocusEmulationEnabled` 管不着——它给的是
      // "页面被当成有焦点"这个谎，只救可信输入（A/B 数字见 browser-ext.ts 的注释）。
      // 而 `bringToFront` 也只是把标签在它那扇窗里变成活动标签，窗口本身没显示照样没帧，
      // 所以它不是这条腿的解药，只是抢屏。
      // 现状：窗口没显示时截图会在扩展侧 1.5s 上界（SCREENSHOT_BUDGET_MS）回一个明确失败，
      // 二维码推不出去 —— 用户看到的是"码没出来"，不是无声地干等。
      const deadline = now() + timeoutMs
      /**
       * **码换了就重新推，不是只抓一次。**
       *
       * 活体 2026-07-29：用户扫完第一张，xhs 又压上来一个新的二维码弹窗（设备/异地验证之类）。
       * 只抓一次的话，Stream 手里攥着的还是第一张——用户对着一张已经作废的图，怎么扫都不成，
       * 而且看不出为什么。
       *
       * **我们不去识别"这是第二次验证"**：那种判据今天叫这个名字、下个月叫别的，认它就是在
       * 追平台的实现。稳定的事实只有一个——**选择器还是那个选择器，但码不是刚才那张了**。
       * 所以判据是"签名变了"，至于它为什么变（过期刷新、二次验证、风控抽检）我们一概不问，
       * 也不需要问。
       *
       * 代价已经付得起：当初"只抓一次"是因为隐藏标签截图要烧 30 秒超时；focus 仿真开回来
       * 之后一次截图约 300ms，按 pollMs 的节拍抓完全在预算内。
       */
      let lastSig: string | null = null
      let challengeCount = 0
      while (true) {
        if (signal.aborted) { emit({ kind: 'failed', facility: spec.facility, reason: 'cancelled' }); return }
        {
          // null = the selector matched nothing yet (page still painting); a throw = the capture
          // itself failed. Neither is fatal: keep polling, and keep trying for the image. The
          // user can always complete the scan in the tab itself, which is how the 2026-07-28
          // live run succeeded even though every capture timed out.
          const sig = await page.qrSignature?.(spec.qrSelector).catch(() => null) ?? null
          // 拿不到签名（页面还没画/元素没有可用的身份）时退化成老行为：只在还没推过码时抓一次。
          // 绝不能反过来"拿不到签名就每轮都推"——那会让前端的图每隔几秒闪一下。
          const changed = sig !== null ? sig !== lastSig : challengeCount === 0
          if (changed) {
            const qr = await page.qrDataUrl(spec.qrSelector).catch(() => null)
            if (qr) {
              lastSig = sig
              challengeCount++
              // `again` 让前端能说人话：第一张是"请扫码登录"，之后的是"出现了新的二维码，
              // 请再扫一次"——用户至少知道自己没做错什么，是平台又要了一遍。
              emit({ kind: 'challenge', facility: spec.facility, qr, again: challengeCount > 1 })
              ctx.onTrace?.(`qr #${challengeCount} pushed (sig=${sig ?? 'n/a'})`)
            }
          }
        }
        // Only LOGGED_IN ends the wait. WALLED = still at the wall, UNKNOWN = neither signal has
        // painted yet — both mean "keep waiting", and conflating them is what the old
        // single-selector check did.
        if ((await page.loginState(ctx.loginCheck)) === 'LOGGED_IN') break
        if (now() >= deadline) { emit({ kind: 'failed', facility: spec.facility, reason: 'login timed out' }); return }
        await new Promise((r) => setTimeout(r, pollMs))
      }
      // Release the tab and call it done. There used to be a cookie-flush wait here: Chromium
      // holds cookies in memory and only writes them to the profile's sqlite periodically, so a
      // login was not durable until that file changed — but that profile was CloakBrowser's,
      // owned by Stream. The session now lives in the user's own Chrome, which is responsible
      // for its own persistence exactly as it is for every other site they log into.
      await page.close(); page = null
      emit({ kind: 'success', facility: spec.facility })
    } catch (e) {
      emit({ kind: 'failed', facility: spec.facility, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      if (page) await page.close().catch(() => {})
      await lock.release().catch(() => {})
    }
  }
}
