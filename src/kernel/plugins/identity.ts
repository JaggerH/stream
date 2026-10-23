import type { Context } from 'cordis'
import { createHash } from 'node:crypto'
import { isSessionAuth, type SessionAuthSpec } from '../../manifest/types.ts'
import { runOnDevice } from '../../devices/run-context.ts'
import { fetchFor } from '../../devices/fetch.ts'
import { findLoginRecipe } from '../../credentials/facility-login.ts'
import { makeIdentityProber, makeNodeProbeIO, type ProbeNode } from '../../identity/prober.ts'
import { makeIdentityService, type IdentityFacility, type IdentityService } from '../../identity/identity-service.ts'
import type { SiteIdentityStore } from '../../identity/identity-store.ts'

declare module 'cordis' {
  interface Context {
    /** 站点身份（`src/kernel/plugins/identity.ts`，browser-identity 计划 3）：每个节点上各 facility 登着谁。
     *  身份表打不开时这一域不挂（ctx key 带域前缀，见 kernel/context.ts）——读它的地方要判空。 */
    siteIdentities?: IdentityService
  }
}

export interface IdentityConfig {
  store: SiteIdentityStore
  /** 节点表：profile 名（「工作 上的账号」）。缺席 = 用节点 id 顶上。 */
  nodes?: { get(nodeId: string): { profileName?: string; label?: string } | undefined }
  log: (...args: unknown[]) => void
}

/** 节点刚连上时等一会儿再问：扩展连上那一刻 cookie 还在往回拉，page 探测的标签也别和用户自己开窗挤在同一秒。 */
const CONNECT_SETTLE_MS = 5_000

/**
 * 站点身份这一域：把 `whoami` 探测接到三个触发上（节点连上、会话 cookie 变化、`ctx.login` 成功），
 * 结果落 `site_identities`。路由（`/api/identities`）由 serve.ts 挂在 `ctx.siteIdentities` 上。
 *
 * 建在 harvest（中继 / 节点）、auth（取快照 / 登录钩子）、packages（whoami 与允许主机）、sources（会话声明 /
 * 登录 recipe）之上。facility 表**每次现取**：包会热装卸。
 */
export const identityPlugin = {
  name: 'identity',
  inject: ['settings', 'sources', 'credentials', 'harvest', 'packages', 'auth'],
  apply(ctx: Context, config: IdentityConfig): void {
    const extRelays = ctx.harvest.extRelays
    const { registry, liveRecipes } = ctx.sources
    const cookieProvider = ctx.credentials.cookieProvider

    /** facility 的会话声明：同一 facility 多条 session 源时取带会话 cookie 的那条（precheck 才用得上）。 */
    const sessionOf = (): Map<string, SessionAuthSpec> => {
      const out = new Map<string, SessionAuthSpec>()
      for (const m of registry.all()) {
        const key = m.facility?.key
        if (!key || !isSessionAuth(m.auth)) continue
        const prev = out.get(key)
        const hasCookies = 'sessionCookies' in m.auth && !!m.auth.sessionCookies?.length
        if (!prev || (hasCookies && !('sessionCookies' in prev && prev.sessionCookies?.length))) out.set(key, m.auth)
      }
      return out
    }
    const facilities = (): IdentityFacility[] => {
      const sessions = sessionOf()
      const keys = new Set([...sessions.keys(), ...ctx.packages.facilities().map((n) => n.facility).filter((f) => ctx.packages.whoamiForFacility(f))])
      return [...keys].sort().map((facility) => {
        const whoami = ctx.packages.whoamiForFacility(facility)
        const session = sessions.get(facility)
        return {
          facility,
          hosts: ctx.packages.networkForFacility(facility)?.hosts ?? [],
          ...(whoami ? { whoami } : {}),
          ...(session ? { session } : {}),
        }
      })
    }

    const nodeOfBinding = (bindingId: string): ProbeNode | undefined => {
      const nodeId = extRelays.nodeOf(bindingId)
      const deviceId = extRelays.deviceOf(bindingId)
      return nodeId && deviceId ? { nodeId, deviceId, bindingId } : undefined
    }
    /** 在钉住该节点的执行上下文里：去它的浏览器拉一份新快照、让缓存重读。拉不到不致命（盘上那份仍是它的）。 */
    const freshSnapshot = async (): Promise<void> => {
      await ctx.auth.cookiePuller.pull('identity').catch(() => {})
      await cookieProvider.refresh()
    }

    const prober = makeIdentityProber(makeNodeProbeIO({
      relay: (bindingId) => extRelays.relay(bindingId),
      fetch: fetchFor,
      refreshCookies: freshSnapshot,
      cookieString: (domain) => cookieProvider.cookieString(domain),
    }))

    const svc = makeIdentityService({
      facilities,
      nodeOfBinding,
      onlineNodes: () => extRelays.statuses()
        .filter((s) => s.online)
        .map((s) => nodeOfBinding(s.bindingId))
        .filter((n): n is ProbeNode => n !== undefined),
      profileName: (nodeId) => {
        const n = config.nodes?.get(nodeId)
        return n?.label ?? n?.profileName
      },
      cookieNames: (node, domain) => extRelays.relay(node.bindingId).cookieNames(domain),
      sessionFingerprint: (node, domain, names) =>
        runOnDevice({ deviceId: node.deviceId, allowHosts: [], browser: { bindingId: node.bindingId } }, async () => {
          try {
            await freshSnapshot()
          } catch {
            return undefined
          }
          const want = new Set(names)
          const hits = (await cookieProvider.cookiesFor(domain))
            .filter((c) => want.has(c.name) && c.value)
            .map((c) => `${c.name}=${c.value}`)
            .sort()
          // 只存值的哈希：指纹只用来比「变没变」，会话 cookie 本身不该在内存里多留一份。
          return hits.length ? createHash('sha256').update(hits.join('\n')).digest('hex') : null
        }),
      loginAccount: (facility, param) => {
        try {
          const [, recipe] = findLoginRecipe(liveRecipes.current, facility)
          const ref = recipe.meta?.runtime_config?.ref
          const v = ref ? ctx.settings.runtimeConfig(ref)[param] : undefined
          return typeof v === 'string' && v.trim() ? v : undefined
        } catch {
          return undefined
        }
      },
      prober,
      store: config.store,
      log: (line) => config.log(line),
    })

    // 节点连上：等它的 cookie 拉回来一轮再问。每条绑定只挂一次 cookie 监听（relay 连上时才建，所以挂在 registry 上）。
    const hooked = new Set<string>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    extRelays.onBindingConnected?.((bindingId) => {
      if (!nodeOfBinding(bindingId)) return
      const t = setTimeout(() => {
        timers.delete(t)
        void svc.nodeConnected(bindingId).catch(() => {})
      }, CONNECT_SETTLE_MS)
      t.unref?.()
      timers.add(t)
      if (hooked.has(bindingId)) return
      hooked.add(bindingId)
      extRelays.relay(bindingId).onCookiesChanged((domains) => svc.cookiesChanged(bindingId, domains))
    })
    ctx.auth.onFacilityLogin((facility, bindingId) => { void svc.afterLogin(facility, bindingId).catch(() => {}) })

    ctx.effect(() => () => {
      for (const t of timers) clearTimeout(t)
      svc.dispose()
    })
    ctx.provide('siteIdentities', svc)
  },
}
