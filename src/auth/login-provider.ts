import type { SessionAuthSpec } from '../manifest/types.ts'
import type { LoginCheck } from '../replay/recipe.ts'

export type LoginEvent =
  /**
   * 有一张码要给用户看。
   *
   * `again` = 这不是本轮的第一张：用户已经扫过一次，平台又压上来一张新的（xhs 的设备/异地
   * 验证会这样，2026-07-29 实测）。前端据此把话说明白——"出现了新的二维码，请再扫一次"，
   * 让用户知道**不是他扫错了**。我们不判断它为什么换，只判断它换了（见 provider 里的签名）。
   */
  | { kind: 'challenge'; facility: string; qr: string; again?: boolean }
  /**
   * 需要用户去浏览器里亲手做点什么（OAuth 的通行密钥、服务条款、二次验证……）。
   *
   * **和 `challenge` 是两件事，别复用它**：`challenge` 带着一张要在 Stream 里显示的图，
   * 而这一条恰恰相反——东西在浏览器那边，Stream 能做的只有把话说清楚。塞一个空 `qr`
   * 进 `challenge` 会让前端渲染一张坏图，而那看起来像 bug，不像"该你了"。
   *
   * 我们**不说**它具体在等哪一种验证（见 BrowserOAuthLoginProvider 的头注）。
   */
  | { kind: 'needsHuman'; facility: string; hint: string }
  | { kind: 'success'; facility: string }
  | { kind: 'failed'; facility: string; reason: string }

export interface LoginContext {
  /** 把这轮登录的关键节点记下来（第几张码、什么时候推的）。这条流程**难复现**，没有痕迹
   *  下次就只能靠猜；有它就能事后翻账本而不是让用户再撞一遍。 */
  onTrace?: (line: string) => void
  /** The recipe's WHOLE loginCheck, not just the success half. Login detection is one capability
   *  with one set of signals; the harvest already judges with all of it (`detectLoginState`), and
   *  the login flow reading only `loggedIn` left it unable to tell "wall still up" from "page not
   *  painted yet". */
  loginCheck: LoginCheck
}

export interface LoginProvider {
  readonly method: SessionAuthSpec['login']
  begin(spec: SessionAuthSpec, ctx: LoginContext, emit: (e: LoginEvent) => void, signal: AbortSignal): Promise<void>
}

export class LoginProviderRegistry {
  private readonly byMethod = new Map<string, LoginProvider>()
  register(p: LoginProvider): void { this.byMethod.set(p.method, p) }
  get(method: string): LoginProvider | undefined { return this.byMethod.get(method) }
}
