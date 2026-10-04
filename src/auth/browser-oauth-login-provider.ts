import type { SessionAuthSpec } from '../manifest/types.ts'
import type { LoginContext, LoginEvent, LoginProvider } from './login-provider.ts'
import type { LoginLock, LoginPage } from './login-page.ts'

export interface OAuthLoginPage extends LoginPage {
  /**
   * 页面内 click。**刻意不是可信输入。**
   *
   * 活体 2026-09-01：`cdp_act` 的 trusted click 对 `console.groq.com` 的 `#oauth-google`
   * 连点两次都没生效——报 `done`、元素也确实命中（`elementFromPoint` 落在按钮自己的 span 上）、
   * 但 handler 一次都没跑；页面内 `.click()` 一次就成。所以这条路径走页面内触发。
   *
   * 找不到元素返回 false（不抛）——调用方要能区分"点了"和"没这个元素"。
   */
  click(selector: string): Promise<boolean>
  /** 把 tab 掀到用户面前。Windows Hello 的框只弹在浏览器上，所以这一格必须抢屏——
   *  和扫码 provider 刻意不抢屏正相反（那边是把图取出来送进 Stream，用户不用切窗口）。 */
  bringToFront(): Promise<void>
}

/** 账号选择器等待窗口——与 `nudgeAfterMs`（要不要提示用户）无关，纯粹是"跳转到
 *  accounts.google.com 需要多久"的经验值，不放进 deps：调用方没有理由需要调它。 */
const ACCOUNT_PICK_WINDOW_MS = 5_000

export interface BrowserOAuthDeps {
  browser: { openProfile(facility: string): Promise<OAuthLoginPage> }
  lock: LoginLock
  pollMs?: number
  timeoutMs?: number
  /** 等这么久还没 LOGGED_IN 就 emit 一条「浏览器里似乎在等你操作」。默认 12_000——理由见 `begin` 里的注释。 */
  nudgeAfterMs?: number
  now?: () => number
}

/**
 * 用用户**自己 Chrome 里已有的登录态**走第三方 OAuth（今天只有 Google）。
 *
 * 与 `BrowserQrLoginProvider` 并列，循环结构一致；差别只有两处：
 * - 扫码是把图**取出来**送进 Stream 前端（不抢屏）；OAuth 是把**用户送过去**（抢屏）。
 * - 扫码等的是"码换了没有"；OAuth 什么都不等，只等 `LOGGED_IN`。
 *
 * **它不认识任何一种人机验证。** 通行密钥、服务条款屏、OAuth 授权屏、2FA、异地验证——
 * 全是同一件事：「此刻需要一个人」。识别它们等于追平台的实现（这条教训写在扫码 provider
 * 的 `qrSignature` 头注）。所以这里只做三件事：把 tab 推到前台、告诉用户该他了、死等
 * `LOGGED_IN`。代价是它对 Google 改版免疫，收益是**新用户那条多一屏条款的路不需要单独实现**。
 */
export class BrowserOAuthLoginProvider implements LoginProvider {
  readonly method = 'oauth' as const
  constructor(private readonly deps: BrowserOAuthDeps) {}

  async begin(
    spec: SessionAuthSpec,
    ctx: LoginContext,
    emit: (e: LoginEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (spec.login !== 'oauth') {
      emit({ kind: 'failed', facility: spec.facility, reason: `facility "${spec.facility}" 不是 oauth 登录` })
      return
    }
    const pollMs = this.deps.pollMs ?? 1500
    const timeoutMs = this.deps.timeoutMs ?? 180_000
    // 不能是 0：OAuth 跳转本身就要一两秒，第一次轮询几乎必然还没 LOGGED_IN——
    // 0 意味着每一次登录都会抢屏 + 喊「该你了」，哪怕再等一秒就自己成了。
    // 喊狼来了的提示用户两次就不看了，等于打掉了这个提示存在的意义。
    // 语义：等这么久还没 LOGGED_IN，才认为大概率是卡在了某种人机验证上，值得开口。
    const nudgeAfterMs = this.deps.nudgeAfterMs ?? 12_000
    const now = this.deps.now ?? Date.now
    const lock = await this.deps.lock.acquire(spec.facility)
    let page: OAuthLoginPage | null = null
    try {
      page = await this.deps.browser.openProfile(spec.facility)
      await page.goto(spec.loginUrl)
      // 点 OAuth 入口。点不着就直接失败——这一步找不到元素通常意味着登录页改版了，
      // 而不是"稍等一下就会出现"；继续往下走只会在选账号那步报一个指错方向的原因。
      if (!(await page.click(spec.oauthButton))) {
        emit({ kind: 'failed', facility: spec.facility, reason: `登录页上找不到 ${spec.oauthButton}` })
        return
      }
      // 选账号。**这一步是可选的**，且有两层原因都会让它被跳过：
      // (1) Google 只有一个登录账号时会跳过选择器直接往下走，那时元素根本不存在；
      // (2) `spec.account` 本身缺席——它是用户各自的邮箱，不是包该提供的东西（manifest 里
      //     没有它是合法的常态，见 types.ts）。缺席时**整段跳过**，绝不能拿 undefined 去
      //     `replace`：那会拼出 `[data-identifier="undefined"]` 这种永不命中的选择器，
      //     把一次正常的降级伪装成一次失败的点击。两种情况都靠后面的 `LOGGED_IN` 轮询兜底，
      //     不是失败。
      if (spec.account) {
        const accountSelector = spec.accountSelector.replace('{email}', spec.account)
        const picked = await this.pickAccount(page, accountSelector, signal, pollMs, now, ACCOUNT_PICK_WINDOW_MS)
        ctx.onTrace?.(`account picked=${picked} selector=${accountSelector}`)
      } else {
        ctx.onTrace?.('account 未配置，跳过自动选账号，等用户自己点')
      }

      // deadline 从这里（选完账号之后）起算，不含上面 pickAccount 最多 ACCOUNT_PICK_WINDOW_MS
      // 的等待——所以墙钟总上限实际是 timeoutMs + ACCOUNT_PICK_WINDOW_MS，不是 timeoutMs 本身。
      // 行为不改（deadline 从选账号后开始计时是有意的：账号选择器的等待不该挤占登录墙的预算），
      // 只是调用方按 timeoutMs 推算总时长时要记得加这一块。
      const startedAt = now()
      const deadline = startedAt + timeoutMs
      let nudged = false
      while (true) {
        if (signal.aborted) { emit({ kind: 'failed', facility: spec.facility, reason: 'cancelled' }); return }
        if ((await page.loginState(ctx.loginCheck)) === 'LOGGED_IN') break
        // 需要人。**靠计时判断，不认页面**——判据只有"等太久了"，所以它对
        // passkey / 条款屏 / 2FA 一视同仁（spec §5.1）。掀屏和提示都只做一次。
        if (!nudged && now() - startedAt >= nudgeAfterMs) {
          nudged = true
          await page.bringToFront().catch(() => {})
          emit({ kind: 'needsHuman', facility: spec.facility, hint: '浏览器里似乎在等你操作一下（可能是指纹或二次验证）' })
          ctx.onTrace?.('nudged: 浏览器里似乎在等用户操作')
        }
        if (now() >= deadline) { emit({ kind: 'failed', facility: spec.facility, reason: 'login timed out' }); return }
        await new Promise((r) => setTimeout(r, pollMs))
      }
      await page.close(); page = null
      emit({ kind: 'success', facility: spec.facility })
    } catch (e) {
      emit({ kind: 'failed', facility: spec.facility, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      if (page) await page.close().catch(() => {})
      await lock.release().catch(() => {})
    }
  }

  /**
   * 账号选择器要等它出现——OAuth 是整页跳转，点完 `#oauth-google` 到 accounts.google.com
   * 画出来中间隔着一次真实导航。轮询几轮找不到就放弃（返回 false）：**那可能是正常的**
   * （单账号直接跳过选择器），所以不是失败，交给后面的 `LOGGED_IN` 轮询说了算。
   */
  private async pickAccount(
    page: OAuthLoginPage,
    selector: string,
    signal: AbortSignal,
    pollMs: number,
    now: () => number,
    windowMs: number,
  ): Promise<boolean> {
    const until = now() + windowMs
    while (now() < until) {
      if (signal.aborted) return false
      if (await page.click(selector)) return true
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return false
  }
}
