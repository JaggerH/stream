import { getConfig, setConfig, mergeDomains } from './config.ts'
import { getSyncConfig } from './stream-api.ts'
import { notifyCookiesChanged } from './relay-notify.ts'

export type SyncReason =
  | 'no_stream_url'
  | 'no_domains'
  /** Stream 那一口没接线（老后端 / 最小装配）——同步范围无从谈起，这一轮什么都不做。 */
  | 'sync_config_unavailable'
  /** 已经把「同步域里的 cookie 变了」叫给后端了。**这不是失败**，popup 要按正常结果显示。 */
  | 'nudged'
  /** 中继没连（Stream 没起 / 还没配对）——叫不动，下次它连上会自己来取。 */
  | 'relay_down'

/** Full outcome of a sync — the popup shows it verbatim so a first run is self-diagnosing.
 *  **判成功只看 `reason`**（`SUCCESS_REASONS`，见 CookiePanel）：这里没有"推没推成功"这种
 *  字段，因为扩展从不把 cookie 发到网络上。 */
export interface SyncResult {
  reason: SyncReason
  /** 每个同步域在浏览器里现有几条 cookie（诊断用，不是判据）。 */
  counts: Record<string, number>
}

/**
 * 一轮同步。**扩展不推 cookie**，它只做两件事：
 *
 * 1. 把 Stream 申报的 `requiredDomains` 刷新进本地缓存——那是 `cookiePull` 的范围闸
 *    （见 driver.ts）；
 * 2. 在中继上叫一声「同步域里的 cookie 变了」。
 *
 * 取数由后端发起，因为**只有它知道什么时候要用**：要采集了、手里那份多旧、刚刚是不是吃了个
 * 401。扩展一样都不知道，所以定时推只能靠猜，猜出来的就是"最长干等一个周期"。
 */
export async function runSync(): Promise<SyncResult> {
  const cfg = await getConfig()
  if (!cfg.baseUrl) return { reason: 'no_stream_url', counts: {} }

  const sc = await getSyncConfig(cfg)
  if (!sc.configured) return { reason: 'sync_config_unavailable', counts: {} }

  // Stream's own requirement is part of the scope, not a suggestion: it is derived from the
  // manifests actually installed there, so it knows about a login-gated facility the moment one
  // is added — which is exactly when a hand-kept list would be silently one domain short.
  // Checked AFTER sync-config for that reason: an empty user list is still a working sync.
  const domains = mergeDomains(cfg.domains, sc.requiredDomains ?? [])

  // 范围先落盘，**在任何早退之前**：它是 `cookiePull` 的闸门，缓存陈旧就等于后端能取的域
  // 比它实际需要的少一个——而那种缺失是静默的（读成"用户没登录"）。夸克那次就是这么来的。
  await setConfig({ requiredDomains: sc.requiredDomains ?? [] })

  if (!domains.length) return { reason: 'no_domains', counts: {} }

  const counts: Record<string, number> = {}
  for (const domain of domains) {
    const n = (await chrome.cookies.getAll({ domain })).length
    if (n) counts[domain] = n
  }

  // 叫一声就完事——把「浏览器里现在有这些域」告诉它，来不来取、什么时候取由它定。
  // 中继没连（Stream 没起）不是错误：它下次连上会自己拉一次全量（后端的 onConnected）。
  const nudged = notifyCookiesChanged(Object.keys(counts))
  if (nudged) await setConfig({ lastSync: Date.now() })
  return { reason: nudged ? 'nudged' : 'relay_down', counts }
}
