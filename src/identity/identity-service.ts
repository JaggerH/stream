/**
 * 身份表的触发（browser-identity D6）：什么时候去问、问谁、答案怎么落表。
 *
 * - 节点连上：只问会话 cookie 在场（`sessionPrecheck` = `PRESENT`）的 facility，按节点串行（探测器保证）。
 *   `http` 形状且 facility 没声明会话 cookie 时照问——它不开标签，代价是一次 GET；`page` 形状没有在场证据就不开标签。
 *   `GONE` 是确定的「没登」：已有记录就标登出，不开标签。
 * - 会话 cookie 在该节点上变了（扩展的 `cookies-changed`）：防抖后，比对声明的会话 cookie 值的指纹，变了才问。
 *   没声明会话 cookie 的退到最短间隔——站点每次加载都轮换一批 cookie，按事件开标签就是采集时每分钟一张探测标签。
 * - 手动刷新（面板 / `POST /api/identities/refresh`）：在线节点上全问一遍，可按节点 / facility 收窄。
 * - `ctx.login` 成功之后（`afterLogin`）：`login` 形状直接写（哈希 + 打码），其余在登录用的那个节点上重新问。
 *
 * 没有 `whoami` 的 facility：身份退化为「这个节点上的账号」，`account_id = node:<nodeId>`，显示「<profile> 上的账号」。
 * 在场与否只看会话 cookie（`PRESENT` → 登着，`GONE` → 登出）。
 *
 * 说不出节点的连接（兼容槽、老配对绑定）一律跳过：表以（facility，节点）为键。
 */
import type { SessionAuthSpec, WhoamiSpec } from '../manifest/types.ts'
import { sessionPrecheck } from '../auth/session-precheck.ts'
import type { IdentityProber, ProbeNode } from './prober.ts'
import type { SiteIdentity, SiteIdentityStore } from './identity-store.ts'
import { cookieDomainFor, loginAccountId, maskAccount, type ProbeResult } from './whoami.ts'

export interface IdentityFacility {
  facility: string
  whoami?: WhoamiSpec
  /** 包允许访问的主机（`network.hosts ?? credentials`）。 */
  hosts: readonly string[]
  /** 这个 facility 的会话声明（`sessionPrecheck` 用；`cookieDomain` + `sessionCookies`）。 */
  session?: SessionAuthSpec
}

export interface IdentityServiceDeps {
  /** 现取：包会热装卸。只列声明了会话或 whoami 的 facility。 */
  facilities(): IdentityFacility[]
  /** 绑定 → 节点；兼容槽与没记过节点的配对绑定回 undefined。 */
  nodeOfBinding(bindingId: string): ProbeNode | undefined
  onlineNodes(): ProbeNode[]
  profileName(nodeId: string): string | undefined
  /** 该节点浏览器里这个域的 cookie 名（只要名字）。 */
  cookieNames(node: ProbeNode, domain: string): Promise<string[]>
  /**
   * 该节点快照里这几个会话 cookie 的值的指纹（拉一份新快照之后算）。一个都不在 → `null`（确定没登）；
   * 取不到（快照读失败）→ `undefined`（不知道）。
   */
  sessionFingerprint(node: ProbeNode, domain: string, names: readonly string[]): Promise<string | null | undefined>
  /** `login` 形状：登录 recipe 那一格此刻的值（runtime_config）。 */
  loginAccount(facility: string, param: string): string | undefined
  prober: IdentityProber
  store: SiteIdentityStore
  now?: () => number
  log?: (line: string) => void
  /** cookie 变化的防抖。 */
  debounceMs?: number
}

/** 没声明会话 cookie 的 facility，cookie 变化触发的最短间隔。 */
export const UNDECLARED_REPROBE_MS = 10 * 60_000
export const COOKIE_CHANGE_DEBOUNCE_MS = 3_000

export interface IdentityOutcome {
  facility: string
  nodeId: string
  result: ProbeResult
}

export interface IdentityView extends SiteIdentity {
  deviceId?: string
  profileName?: string
  online: boolean
}

export const nodeAccountId = (nodeId: string): string => `node:${nodeId}`

export function makeIdentityService(deps: IdentityServiceDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const debounceMs = deps.debounceMs ?? COOKIE_CHANGE_DEBOUNCE_MS
  /** （facility，节点）→ 上次见到的会话 cookie 指纹。进程内即可：重启之后节点重连，连上那次会问。 */
  const fingerprints = new Map<string, string | null>()
  /** （facility，节点）→ 上次因 cookie 变化而问的时刻（没声明会话 cookie 的那条退路用）。 */
  const lastChangeProbe = new Map<string, number>()
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; domains: Set<string> | null }>()
  const key = (f: string, n: string) => `${f}\u0000${n}`

  const nodeDisplay = (nodeId: string) => `${deps.profileName(nodeId) ?? nodeId} 上的账号`
  const domainOf = (f: IdentityFacility): string | undefined =>
    f.session?.cookieDomain ?? (f.whoami && f.whoami.kind !== 'login' ? cookieDomainFor(f.whoami.url, f.hosts) : undefined)
  const sessionCookiesOf = (f: IdentityFacility): string[] | undefined =>
    f.session && 'sessionCookies' in f.session && f.session.sessionCookies?.length ? f.session.sessionCookies : undefined

  const write = (f: string, node: ProbeNode, result: ProbeResult): IdentityOutcome => {
    const { written, before } = deps.store.record(f, node.nodeId, result)
    if (written && result.state === 'signed-in' && before?.accountId && before.accountId !== result.accountId) {
      log(`[identity] ${f} @ ${node.nodeId}: 账号从 ${before.accountId} 换成了 ${result.accountId}`)
    }
    return { facility: f, nodeId: node.nodeId, result }
  }
  /** 确定登出（GONE）：只在已有记录时标——从没登过的站不必在表里占一行。 */
  const markGone = (f: string, node: ProbeNode): IdentityOutcome => {
    const result: ProbeResult = deps.store.get(f, node.nodeId) ? { state: 'signed-out' } : { state: 'unknown', reason: '会话 cookie 不在，且没有旧记录' }
    return write(f, node, result)
  }
  const precheck = (f: IdentityFacility, node: ProbeNode) =>
    f.session ? sessionPrecheck(f.session, (d) => deps.cookieNames(node, d)) : Promise.resolve('UNKNOWN' as const)

  const probe = async (f: IdentityFacility, node: ProbeNode): Promise<IdentityOutcome> =>
    write(f.facility, node, await deps.prober.probe(node, f.whoami!, f.hosts))

  /** 没有 whoami：节点就是身份，在场看会话 cookie。 */
  const identifyByNode = async (f: IdentityFacility, node: ProbeNode): Promise<IdentityOutcome | undefined> => {
    const p = await precheck(f, node)
    if (p === 'PRESENT') return write(f.facility, node, { state: 'signed-in', accountId: nodeAccountId(node.nodeId), name: nodeDisplay(node.nodeId) })
    if (p === 'GONE') return markGone(f.facility, node)
    return undefined
  }

  const rememberFingerprint = async (f: IdentityFacility, node: ProbeNode): Promise<string | null | undefined> => {
    const names = sessionCookiesOf(f)
    const domain = domainOf(f)
    if (!names || !domain) return undefined
    const fp = await deps.sessionFingerprint(node, domain, names).catch(() => undefined)
    // 不知道就不记：下次照旧当「没见过」处理，而不是把「读失败」当成一个指纹。
    if (fp !== undefined) fingerprints.set(key(f.facility, node.nodeId), fp)
    return fp
  }

  /** 节点连上（含重连）。 */
  const nodeConnected = async (bindingId: string): Promise<IdentityOutcome[]> => {
    const node = deps.nodeOfBinding(bindingId)
    if (!node) return []
    const out: IdentityOutcome[] = []
    for (const f of deps.facilities()) {
      try {
        if (!f.whoami) { const o = await identifyByNode(f, node); if (o) out.push(o); continue }
        if (f.whoami.kind === 'login') continue
        const p = await precheck(f, node)
        await rememberFingerprint(f, node)
        if (p === 'GONE') { out.push(markGone(f.facility, node)); continue }
        // 在场才问；`http` 没有在场证据（没声明会话 cookie / 问不出来）也问——不开标签。
        if (p === 'PRESENT' || (p === 'UNKNOWN' && f.whoami.kind === 'http')) out.push(await probe(f, node))
      } catch (e) {
        log(`[identity] ${f.facility} @ ${node.nodeId} 连上时没问成：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  }

  const matchesDomain = (f: IdentityFacility, domains: Set<string> | null): boolean => {
    if (!domains || domains.size === 0) return true // 扩展没说哪个域变了：都算
    const d = domainOf(f)
    if (!d) return false
    for (const x of domains) {
      const c = x.replace(/^\./, '').toLowerCase()
      if (c === d || c.endsWith(`.${d}`) || d.endsWith(`.${c}`)) return true
    }
    return false
  }

  const onCookiesSettled = async (bindingId: string, domains: Set<string> | null): Promise<IdentityOutcome[]> => {
    const node = deps.nodeOfBinding(bindingId)
    if (!node) return []
    const out: IdentityOutcome[] = []
    for (const f of deps.facilities()) {
      if (!matchesDomain(f, domains)) continue
      try {
        if (!f.whoami) { const o = await identifyByNode(f, node); if (o) out.push(o); continue }
        if (f.whoami.kind === 'login') continue
        const k = key(f.facility, node.nodeId)
        if (sessionCookiesOf(f)) {
          const before = fingerprints.get(k)
          const known = fingerprints.has(k)
          const fp = await rememberFingerprint(f, node)
          if (fp === undefined) continue // 读不到快照：问不出来，不动
          if (known && fp === before) continue // 会话 cookie 没变：别的 cookie 在轮换，不是换号
          if (fp === null) { out.push(markGone(f.facility, node)); continue } // 会话 cookie 没了
          out.push(await probe(f, node))
        } else {
          const last = lastChangeProbe.get(k)
          if (last !== undefined && now() - last < UNDECLARED_REPROBE_MS) continue
          lastChangeProbe.set(k, now())
          out.push(await probe(f, node))
        }
      } catch (e) {
        log(`[identity] ${f.facility} @ ${node.nodeId} cookie 变化后没问成：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  }

  /** 扩展报「cookie 变了」：同一绑定上的连发合并成一次（域取并集）。 */
  const cookiesChanged = (bindingId: string, domains: string[]): void => {
    const p = pending.get(bindingId)
    const merged = p?.domains === null || domains.length === 0 ? null : new Set([...(p?.domains ?? []), ...domains])
    if (p) clearTimeout(p.timer)
    const timer = setTimeout(() => {
      pending.delete(bindingId)
      void onCookiesSettled(bindingId, merged).catch(() => {})
    }, debounceMs)
    timer.unref?.()
    pending.set(bindingId, { timer, domains: merged })
  }

  /** 手动刷新：在线节点上全问一遍。`login` 形状没有可问的，原样跳过。 */
  const refresh = async (filter: { nodeId?: string; facility?: string } = {}): Promise<IdentityOutcome[]> => {
    const nodes = deps.onlineNodes().filter((n) => filter.nodeId === undefined || n.nodeId === filter.nodeId)
    const facilities = deps.facilities().filter((f) => filter.facility === undefined || f.facility === filter.facility)
    const perNode = await Promise.all(nodes.map(async (node) => {
      const out: IdentityOutcome[] = []
      for (const f of facilities) {
        if (!f.whoami) { const o = await identifyByNode(f, node).catch(() => undefined); if (o) out.push(o); continue }
        if (f.whoami.kind === 'login') continue
        await rememberFingerprint(f, node)
        out.push(await probe(f, node))
      }
      return out
    }))
    return perNode.flat()
  }

  /** `ctx.login(facility)` 成功之后：登录用的就是 `bindingId` 那个节点。 */
  const afterLogin = async (facility: string, bindingId: string): Promise<IdentityOutcome | undefined> => {
    const node = deps.nodeOfBinding(bindingId)
    if (!node) return undefined
    const f = deps.facilities().find((x) => x.facility === facility)
    if (!f?.whoami) {
      // 刚登上：这个节点上的账号在场（不必再问 cookie）。
      return write(facility, node, { state: 'signed-in', accountId: nodeAccountId(node.nodeId), name: nodeDisplay(node.nodeId) })
    }
    if (f.whoami.kind === 'login') {
      const account = deps.loginAccount(facility, f.whoami.param)
      if (!account) return undefined
      // 明文不落库：id 存哈希、显示打码（D5）。
      return write(facility, node, { state: 'signed-in', accountId: loginAccountId(account), name: maskAccount(account) })
    }
    await rememberFingerprint(f, node)
    return probe(f, node)
  }

  /** 表 + 节点信息。`node:` 身份的显示名按此刻的 profile 名现算（认领之后名字才有）。 */
  const list = (filter: { nodeId?: string; facility?: string } = {}): IdentityView[] => {
    const online = new Map(deps.onlineNodes().map((n) => [n.nodeId, n]))
    return deps.store.list(filter).map((i) => {
      const profileName = deps.profileName(i.nodeId)
      const n = online.get(i.nodeId)
      return {
        ...i,
        ...(i.accountId === nodeAccountId(i.nodeId) ? { displayName: nodeDisplay(i.nodeId) } : {}),
        ...(n ? { deviceId: n.deviceId } : {}),
        ...(profileName ? { profileName } : {}),
        online: n !== undefined,
      }
    })
  }

  const dispose = () => {
    for (const p of pending.values()) clearTimeout(p.timer)
    pending.clear()
  }

  return { nodeConnected, cookiesChanged, refresh, afterLogin, list, dispose }
}

export type IdentityService = ReturnType<typeof makeIdentityService>
