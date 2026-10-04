import type { Config } from './config.ts'
import type { CapabilitySnapshot } from './relay-health.ts'

const base = (c: Config) => c.baseUrl.replace(/\/$/, '')

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export interface RadarMatch {
  sourceId: string
  params: Record<string, string>
  title: string
  /** the source's cookie-auth domain when it needs login — the popup offers to sync it. */
  authDomain?: string
}

export interface RadarResult {
  input: string
  matches: RadarMatch[]
  fallback: 'generic-url' | 'unknown'
}

/**
 * 该同步哪些域的 cookie，由 Stream 下发。
 *
 * **扩展从不把 cookie 发到网络上**：登录态由后端在需要的那一刻来取（`op:'cookiePull'`，走中继）。
 * 这一口只回答范围，因此**不含也不许含任何密钥**。
 */
export interface SyncConfig {
  configured: boolean
  /** Cookie domains Stream itself says it needs (derived from its installed manifests). Unioned
   *  with the user's configured domains at sync time — see mergeDomains. Absent on older backends. */
  requiredDomains?: string[]
}

/** Resolve a URL into the candidate Stream sources (RSSHub catalog + native plugins) that can ingest it.
 *  路径是 `/api/radar` —— `/api/intents` 是**意图跟踪**那份资源（另一个东西），别指回去。 */
export const getRadar = (c: Config, url: string): Promise<RadarResult> =>
  fetch(`${base(c)}/api/radar?input=${encodeURIComponent(url)}`).then(j<RadarResult>)

/** Ask Stream which cookie domains it needs synced (Stream owns this list — see SyncConfig). */
export const getSyncConfig = (c: Config): Promise<SyncConfig> =>
  fetch(`${base(c)}/api/ext/sync-config`).then(j<SyncConfig>)

/**
 * 后端对「浏览器采集这条链具备不具备」的**快判**（纯读，永远秒回，不探测不唤醒）。
 * 弹窗拿它把"我们这个 SW 没连上"这个歧义答案拆开——见 lib/relay-health.ts 的头注。
 * 老后端没有这一口（404），一律当"读不到"处理，不能因此把弹窗判成故障。
 */
export const getBrowserCapability = (c: Config): Promise<CapabilitySnapshot> =>
  fetch(`${base(c)}/api/browser-capability`).then(j<CapabilitySnapshot>)
