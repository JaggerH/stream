import type { PluginDescriptor } from './types.ts'
import { pluginTarget } from './plugin-target.ts'
import { normalizeHealthPath } from './health-path.ts'
import { standbySnapshot } from './standby/hook.ts'

export interface PluginStatus {
  id: string
  /** a backend (or resolvable url) is present */
  configured: boolean
  health: 'ok' | 'down' | 'unknown'
  /** health-probe wall time in ms (absent when nothing was probed: in-process plugin, or no base) */
  probeMs?: number
  /** probed backend base url (debug surface; never rendered as user-facing config) */
  base?: string
  /** 闲置回收状态(standby-manager 管的服务才有);未接线/该插件不归它管 → absent,输出对象上不带这个键 */
  standby?: { state: string; lastUsed: number | null; lastWakeMs: number | null }
}

/** A down backend must not hold the catalog hostage: the probe is a liveness *hint*, so it
 *  gets one short window instead of a full connect timeout (3s × N down containers was the
 *  10s "Plugins page hang" — see DebugBox channel `plugins`). */
export const PROBE_TIMEOUT_MS = 1200

async function probe(base: string, healthPath: string): Promise<'ok' | 'down'> {
  // 归一化的唯一实现在 health-path.ts —— 三处拼 health URL 的地方共用它（判据一分家，
  // 落下的那一处不会报错，它只是拼出一个指向别处的 URL；见那个模块的头注）。
  const path = normalizeHealthPath(healthPath)
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return r.ok ? 'ok' : 'down'
  } catch {
    return 'down'
  }
}

/**
 * Read-only status of every loaded plugin: configured?, and health (probing the descriptor's
 * health path). `resolveUrl` is injected (bootstrap knows the per-plugin config override);
 * when it returns undefined the plugin's gateway default is used.
 *
 * There is deliberately NO local-vs-cloud mode here. It used to exist as a derived badge value
 * (loopback hostname → local, anything else → cloud, overridable by a stored user choice), but
 * nothing branched on it: a plugin's real request URL is built by each adapter from config/env,
 * never from this field. It only mislabelled Stream's own compose containers as "cloud" because
 * their container-DNS hostnames aren't loopback. What a user cares about is whether the backend
 * is reachable — that's `health`.
 */
export async function aggregatePluginStatus(
  plugins: PluginDescriptor[],
  resolveUrl: (p: PluginDescriptor) => string | undefined
): Promise<PluginStatus[]> {
  return Promise.all(
    plugins.map(async (p): Promise<PluginStatus> => {
      // in-process 插件(无 backend)在下面这行直接早退、不带 standby 键 —— 保证它们的输出对象
      // 跟接线前字节对字节相同;所以 standby 的计算放在早退之后,不用为一条必被丢弃的查找结果
      // 找理由(standby-manager 本就只认领声明了 backend.standby 的服务)。
      if (!p.backend) return { id: p.id, configured: true, health: 'unknown' }
      const serviceName = p.backend.service ?? p.id
      const standbyEntry = standbySnapshot().find((s) => s.service === serviceName)
      const standby = standbyEntry
        ? { state: standbyEntry.state, lastUsed: standbyEntry.lastUsed, lastWakeMs: standbyEntry.lastWakeMs }
        : undefined
      // server-side fetch base (NOT the client-facing gateway path): explicit config wins, else
      // the bootstrap-injected plugin target (compose mode: container DNS; none: null — desktop
      // has no gateway). A null base means there's nothing to probe: report unknown, don't fetch
      // (a down-looking status would be misleading — it's unconfigured, not unreachable).
      // `{ peek: true }`：这一问**只为显示状态**，不唤醒、也不打算拿它发请求——host 档下睡着的
      // 容器必然答空，那是正确答案，不该进 `plugin-target` 故障频道（见 PluginTargetOpts.peek）。
      const base = resolveUrl(p) ?? pluginTarget(p.backend.service ?? p.id, { peek: true }) ?? undefined
      if (!base) return { id: p.id, configured: true, health: 'unknown', ...(standby ? { standby } : {}) }
      // standby-managed backends self-heal on demand: ensureAwake wakes a sleeping (or crashed)
      // container the next time it's actually used, so a live HTTP probe here can't tell the
      // user anything actionable — it would just pay the network round trip (PROBE_TIMEOUT_MS
      // worst case, the real cause of "every open of the plugin panel waits ~1s") to learn what
      // the standby snapshot already answers for free. 'awake' means it answered its own health
      // check when it last woke; anything else just means it isn't woken right now, not "down".
      if (standby) return { id: p.id, configured: true, health: standby.state === 'awake' ? 'ok' : 'unknown', base, standby }
      const started = Date.now()
      const health = await probe(base, p.backend.health ?? '/')
      return {
        id: p.id,
        configured: true,
        health,
        probeMs: Date.now() - started,
        base,
      }
    })
  )
}
