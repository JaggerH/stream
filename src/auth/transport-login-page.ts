import { detectLoginState } from '../replay/actions.ts'
import type { Transport } from '../replay/transport.ts'
import type { OAuthLoginPage } from './browser-oauth-login-provider.ts'

/** The bit of a session lease this needs: the page handle to drive, and how to let it go.
 *  `rawPage` is optional to match `RecipeSessionLease` — the transport's own primitives are what
 *  decide whether a given handle is usable, so it is passed through rather than checked here. */
export interface LoginLease {
  rawPage?: unknown
  release(): Promise<void>
}

/**
 * The QR-login page, built over a harvest lane's Transport.
 *
 * Everything goes through the Transport rather than Playwright. That is not a style preference:
 * the lane's `rawPage` is the extension relay's handle on a tab in the user's own Chrome, so a
 * `page.locator(...)` call — which is what this used to do — throws on the first line. It only
 * ever appeared to work because the acquire declared no transport and the retired default routed
 * it to a browser where `rawPage` WAS a Playwright page.
 *
 * `close` RELEASES the lane instead of closing it: the point of logging in on the harvest lane is
 * that the next harvest inherits the session, which it cannot do if the tab goes away.
 */
export function makeTransportLoginPage(transport: Transport, lease: LoginLease): OAuthLoginPage {
  const raw = lease.rawPage
  const driver = transport.driverFactory(raw)
  return {
    goto: (url) => driver.goto(url, 'load'),
    // A JPEG of just the QR element. null = the selector matched nothing, which the caller reads
    // as "no challenge on screen yet" and polls again — not as a failure.
    qrDataUrl: async (selector) => {
      // 多留一圈白边：QR 规范要求四周有静默区（quiet zone），紧贴元素边框裁会把它切掉，
      // 手机就扫不出来（2026-07-29 用户实测「边缘扫不出」）。12% 短边、最少 16px —— 一个
      // 25×25 模块、180px 宽的码差不多 7px 一模块，四模块的静默区约 28px，这个比例正好盖住。
      // 多留白不会有副作用（扫码器只找定位图案），少留白直接扫不出，所以偏大给。
      const buf = await transport.elementShot(raw, selector, 0.12)
      return buf ? 'data:image/jpeg;base64,' + buf.toString('base64') : null
    },
    /**
     * 这张码的身份：优先读 `<img>` 的 `src`（xhs 的码就是 img，换一张码 = 换一个 src），
     * 没有 src 就退到 `outerHTML` 的长度 + 尺寸这种粗签名。**不比截图字节**：同一张码两次
     * 截图未必字节相同（抗锯齿/动画/JPEG 量化），拿它当判据会把"还是那张"误报成"又换了"。
     *
     * 读不到（选择器没命中、页面还没画）→ null，调用方退回"只推第一张"的老行为。
     */
    qrSignature: async (selector) => {
      const v = await transport.evaluate(
        raw,
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const src = el.getAttribute && el.getAttribute('src');
          if (src) return 'src:' + src;
          const r = el.getBoundingClientRect();
          return 'html:' + (el.outerHTML || '').length + ':' + Math.round(r.width) + 'x' + Math.round(r.height) })()`,
      )
      return typeof v === 'string' ? v : null
    },
    // Delegates to the harvest's own verdict function — this must not become a second
    // implementation of "am I logged in".
    loginState: (check) => detectLoginState(driver, check),
    close: () => lease.release(),
    /**
     * 页面内触发，不是可信输入。活体 2026-09-01：`cdp_act` 的 trusted click 对
     * `console.groq.com` 的 `#oauth-google` 连点两次都没生效（报 done、`elementFromPoint`
     * 也确实命中按钮自己的 span，但 handler 一次都没跑），页面内 `.click()` 一次就成。
     *
     * 返回「有没有这个元素」而不是「点没点成」：调用方要靠它区分"页面还没画出来"和
     * "这一页压根没有这个按钮"。
     */
    click: async (selector) => {
      const hit = await transport.evaluate(
        raw,
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false; el.click(); return true })()`,
      )
      return hit === true
    },
    bringToFront: () => transport.bringToFront(raw),
  }
}
