export interface Config {
  /** The Stream instance base URL (also used for radar subscribe). The only required setting. */
  baseUrl: string
  /** Which cookie domains to sync (scope only — not a credential). User-owned: only the popup
   *  writes it. The domains Stream itself requires arrive separately (requiredDomains). */
  domains: string[]
  /** Last-seen `requiredDomains` from Stream's sync-config — a CACHE, not user config. Kept so the
   *  cookie-change trigger knows the full synced scope without a round-trip on every cookie event;
   *  refreshed on each sync. */
  requiredDomains?: string[]
  lastSync?: number
  /** cookie 变了要不要自动叫 Stream 来取。手动同步不受它管。
   *  （曾经还有一个 `syncIntervalMinutes`——周期同步撤掉之后它没有消费方了，一并删掉。
   *  别加回来：按时间猜的代价就是 cookie 轮换后干等一整个周期。） */
  autoSync: boolean
}

const DEFAULTS: Config = { baseUrl: '', domains: [], autoSync: true }

/** Normalize free-typed domain input into a bare host: lowercase, drop scheme/path/leading dots. Empty → ''. */
export function parseDomainInput(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  return s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\.+/, '')
}

export async function getConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get('config')
  return { ...DEFAULTS, ...(stored.config as Partial<Config> | undefined) }
}

export async function setConfig(patch: Partial<Config>): Promise<void> {
  const next = { ...(await getConfig()), ...patch }
  await chrome.storage.local.set({ config: next })
}

/** Union two domain lists, normalizing each entry. First list's order is preserved, new ones
 *  appended. Empty/blank entries dropped. */
export function mergeDomains(configured: string[], extra: string[] = []): string[] {
  const out: string[] = []
  for (const d of [...configured, ...extra]) {
    const n = parseDomainInput(d)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/** Union the configured sync domains with the login (`auth:cookie`) domains of the
 *  current page's candidate sources, so subscribing a login-gated source nudges its
 *  cookie into sync. Deduped; configured order preserved, new domains appended. */
export function syncableDomains(configured: string[], candidates: { authDomain?: string }[]): string[] {
  return mergeDomains(
    configured,
    candidates.map((c) => c.authDomain ?? '')
  )
}

/** Does a changed cookie's domain (as reported by chrome.cookies.onChanged — may carry a
 *  leading dot) belong to one of the synced domains (bare hosts, see parseDomainInput)?
 *  Used to gate the cookie-change push trigger: without this, ANY site's cookie churn
 *  (feeds, analytics…) fires a full push of the synced domains' unchanged cookies. */
export function matchesSyncedDomain(cookieDomain: string, synced: string[]): boolean {
  const d = cookieDomain.replace(/^\.+/, '').toLowerCase()
  return synced.some((s) => d === s || d.endsWith('.' + s))
}

/** Candidate Stream URLs to try pairing against when none is configured. This is a list of
 *  addresses to ASK, not a list of addresses to TRUST：`findPairedPeer` 要求每个候选各自算出
 *  proof，而 native host 只交出**一份** token（`~/.stream/datadir` 指针指向谁就是谁），所以
 *  至多一个候选能证明、其余自动出局——加一个新地址不新增信任，只是多问一句。
 *  8900 排第一：不是更可信，是绝大多数机器上它就是答案，让常见情形少一次注定失败的往返。
 *  8907 是 `@streamapp/desktop` 的 relay 口（没有 Stream 后端的机器上，那个能力包
 *  就是唯一的配对对象）——**端口数字与该包 `src/index.ts` 的 `DEFAULT_PORT` 是同一个数写在
 *  两处**，改一边记得同步另一边。 */
export const PROBE_CANDIDATES = ['http://127.0.0.1:8900', 'http://127.0.0.1:8907']
