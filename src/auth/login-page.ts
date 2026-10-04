import type { LoginCheck, LoginState } from '../replay/recipe.ts'

export interface LoginPage {
  goto(url: string): Promise<void>
  qrDataUrl(selector: string): Promise<string | null>
  /**
   * 这张码的**身份**，用来判断"页面上的码换了没有"——不是内容比对，是一个便宜的标识。
   *
   * 为什么不直接比截图字节：同一张码两次截图未必字节相同（抗锯齿、动画、JPEG 量化），
   * 拿它当判据会误报成"又换了一张"，前端就会每隔几秒闪一次。
   *
   * 拿不到就返回 null，调用方退回"只推第一张"的老行为。可选：老的 LoginPage 实现没有它。
   */
  qrSignature?(selector: string): Promise<string | null>
  /** The recipe's full three-state login verdict — the same `detectLoginState` the harvest uses,
   *  not a re-implementation. Reading only `loggedIn` (as this did) collapses "still at the wall"
   *  and "page hasn't painted yet" into one indistinguishable answer. */
  loginState(check: LoginCheck): Promise<LoginState>
  close(): Promise<void>
}
export interface LoginBrowser {
  openProfile(facility: string): Promise<LoginPage>
}
export interface LoginLock { acquire(facility: string): Promise<{ release: () => Promise<void> }> }
