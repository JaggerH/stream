/**
 * 在一个节点上问站点「我是谁」（browser-identity D5）。
 *
 * - `http`：钉在该节点上发（`runOnDevice` 带上它的绑定）——cookie 取自**该节点**的快照（D10），出站走 `fetchFor`，
 *   远程设备上由设备代发。不开标签。
 * - `page`：在该节点自己的 relay 上开一张后台标签（扩展把它放进这个 profile 的 Stream 标签组、标成 probe），
 *   `load` 之后读路径、关掉。读失败也关：没人在看这张标签。
 * - `login`：不探测（账号在登录那一刻就知道，见 identity-service 的 `afterLogin`）。
 *
 * **同一节点上串行。** 一次一个标签：连上那一刻要问好几个 facility，同时开五张后台标签既像机器人，也会让这个
 * profile 的扩展同时扛五条导航。不同节点之间互不等。
 */
import type { WhoamiSpec } from '../manifest/types.ts'
import { runOnDevice } from '../devices/run-context.ts'
import { BROWSER_UA } from '../../shared/package-sdk/browser-ua.ts'
import { makeExtensionLauncher, type ExtRelayLike } from '../replay/browser-ext.ts'
import { classifyHttp, classifyPage, cookieDomainFor, pagePaths, pageReadExpr, type ProbeResult } from './whoami.ts'

export interface ProbeNode {
  nodeId: string
  deviceId: string
  bindingId: string
}

/** 探测器要的两样原料。真实现见 `makeNodeProbeIO`；测试换假货。 */
export interface ProbeIO {
  /**
   * 在该节点上带它的登录态 GET 一次。快照里这个域一个 cookie 都没有时不发：取过这个域 → `'no-cookies'`（确定没登）；
   * 没取过（被扩展拒、这台设备不取它、一轮都没取成）→ `null`（不知道，不是登出）。
   */
  httpGet(node: ProbeNode, url: string, opts: { cookieDomain: string; allowHosts: readonly string[] }): Promise<{ status: number; body: string } | 'no-cookies' | null>
  /** 在该节点的后台标签里打开 `url`，`load` 后求值 `expression`，关标签。 */
  evalInPage(node: ProbeNode, url: string, expression: string): Promise<unknown>
}

export interface IdentityProber {
  /** 问一次。永不抛：问不出来就是 `unknown`。 */
  probe(node: ProbeNode, whoami: WhoamiSpec, hosts: readonly string[]): Promise<ProbeResult>
}

/** 一次探测的总上限。`page` 要等一次完整的页面加载；中继自己的命令超时是 30 秒。 */
export const PROBE_TIMEOUT_MS = 45_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`探测超过 ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

export function makeIdentityProber(io: ProbeIO, opts: { timeoutMs?: number } = {}): IdentityProber {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  // 每个节点一条尾巴：新探测接在上一个后面（无论上一个成败）。
  const tails = new Map<string, Promise<unknown>>()

  const once = async (node: ProbeNode, w: WhoamiSpec, hosts: readonly string[]): Promise<ProbeResult> => {
    if (w.kind === 'login') return { state: 'unknown', reason: 'login 形状不探测——账号在登录那一刻写入' }
    try {
      if (w.kind === 'http') {
        const cookieDomain = cookieDomainFor(w.url, hosts)
        if (!cookieDomain) return { state: 'unknown', reason: `${w.url} 不在允许主机内` }
        const res = await withTimeout(io.httpGet(node, w.url, { cookieDomain, allowHosts: hosts }), timeoutMs)
        if (!res) return { state: 'unknown', reason: `节点上没有 ${cookieDomain} 的登录态快照` }
        if (res === 'no-cookies') return { state: 'signed-out' }
        return classifyHttp(w, res)
      }
      const read = await withTimeout(io.evalInPage(node, w.url, pageReadExpr(pagePaths(w))), timeoutMs)
      return classifyPage(w, read)
    } catch (e) {
      // 节点中途断开（ExtRelayDisconnected）、超时、设备拒绝——都是「问不出来」。
      return { state: 'unknown', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    probe(node, whoami, hosts) {
      const prev = tails.get(node.nodeId) ?? Promise.resolve()
      const run = prev.then(() => once(node, whoami, hosts))
      const tail = run.catch(() => {})
      tails.set(node.nodeId, tail)
      // 尾巴走完且没人再接上来，就把它摘掉，别让一张 map 跟着节点数一直长。
      void tail.then(() => { if (tails.get(node.nodeId) === tail) tails.delete(node.nodeId) })
      return run
    },
  }
}

export interface NodeProbeIODeps {
  /** 这条绑定的 relay（`ExtRelayRegistry.relay`）。 */
  relay(bindingId: string): ExtRelayLike
  /** 出站入口（`fetchFor`）：执行上下文在远程设备上时由设备代发。 */
  fetch: typeof fetch
  /** 去该节点的浏览器取一份新快照并让缓存重读——在钉住该节点的执行上下文里调用。 */
  refreshCookies(): Promise<void>
  /** 该节点快照里这个域的 Cookie 头（`CookieProvider.cookieString`，按执行上下文的槽位读）。 */
  cookieString(domain: string): Promise<string | null>
  /** 该节点的快照取过这个域没有（`CookiePuller.covers`，同一个槽位）。取过而空着 = 没登；没取过 = 不知道。 */
  snapshotCovers(domain: string): boolean
}

/** 真实的原料：http 钉在节点上走 `fetchFor`，page 走该节点 relay 的后台标签。 */
export function makeNodeProbeIO(deps: NodeProbeIODeps): ProbeIO {
  return {
    httpGet(node, url, { cookieDomain, allowHosts }) {
      // 钉住这个节点：槽位解析（cookie-slot.ts）读的就是它的快照，fetchFor 按它所在的设备选出站。
      return runOnDevice({ deviceId: node.deviceId, allowHosts, browser: { bindingId: node.bindingId } }, async () => {
        // 拉新快照失败不致命：盘上那份仍是这个节点的，只是可能旧一点。
        await deps.refreshCookies().catch(() => {})
        const cookie = await deps.cookieString(cookieDomain)
        if (!cookie) return deps.snapshotCovers(cookieDomain) ? 'no-cookies' as const : null
        const res = await deps.fetch(url, {
          headers: { cookie, 'user-agent': BROWSER_UA, referer: `${new URL(url).origin}/`, accept: 'application/json, text/html;q=0.9' },
          signal: AbortSignal.timeout(20_000),
        })
        return { status: res.status, body: await res.text() }
      })
    },
    async evalInPage(node, url, expression) {
      const { rawPage, close } = await makeExtensionLauncher(deps.relay(node.bindingId)).launch(url, 'load')
      try {
        return await (rawPage as { evalExpr(e: string): Promise<unknown> }).evalExpr(expression)
      } finally {
        await close().catch(() => {})
      }
    },
  }
}
