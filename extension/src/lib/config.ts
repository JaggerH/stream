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

// ── 扩展绑定（design D7）：一个扩展可以同时服务好几个 Stream ──
//
// 本机那条（`local`）就是上面的 `config`，**原样不动**：没有迁移，回滚到旧扩展也照常能用。
// 配对来的那些存在另一个键（`bindings`）里，各带一把实例发的 token。

export const LOCAL_BINDING = 'local'
const BINDINGS_KEY = 'bindings'

export interface Binding {
  /** `local` 或实例发的 `ext:<uuid>`。 */
  id: string
  kind: 'local' | 'paired'
  baseUrl: string
  /** 只有配对绑定落盘 token；本机绑定每次经 native host 现取（见 native-host.ts）。 */
  token?: string
  label: string
  /** 绑定挂在实例上的哪台设备（配对时实例回的设备名）。 */
  deviceName?: string
  domains: string[]
  requiredDomains?: string[]
  /** 配对绑定：用户批准过的 requiredDomains。**远程实例新要的域名不自动生效。** */
  approvedDomains?: string[]
  autoSync: boolean
  /** 实例撤销了这条绑定（关闭码 4003）：不再重连，等用户在 popup 里移除。 */
  revoked?: boolean
  lastSync?: number
}

function localBinding(cfg: Config): Binding {
  return {
    id: LOCAL_BINDING,
    kind: 'local',
    baseUrl: cfg.baseUrl,
    label: '本机 Stream',
    domains: cfg.domains,
    ...(cfg.requiredDomains ? { requiredDomains: cfg.requiredDomains } : {}),
    autoSync: cfg.autoSync,
    ...(cfg.lastSync !== undefined ? { lastSync: cfg.lastSync } : {}),
  }
}

async function pairedBindings(): Promise<Binding[]> {
  const stored = await chrome.storage.local.get(BINDINGS_KEY)
  const list = stored[BINDINGS_KEY]
  return Array.isArray(list) ? (list as Binding[]) : []
}

/** 全部绑定：本机那条在前。 */
export async function getBindings(): Promise<Binding[]> {
  return [localBinding(await getConfig()), ...(await pairedBindings())]
}

export async function getBinding(id: string): Promise<Binding | undefined> {
  return (await getBindings()).find((b) => b.id === id)
}

export async function addBinding(b: Binding): Promise<void> {
  const rest = (await pairedBindings()).filter((x) => x.id !== b.id)
  await chrome.storage.local.set({ [BINDINGS_KEY]: [...rest, b] })
}

/** 改一条绑定。本机那条落回 `config`（只认 config 里有的那几格）。 */
export async function setBinding(id: string, patch: Partial<Binding>): Promise<void> {
  if (id === LOCAL_BINDING) {
    const { baseUrl, domains, requiredDomains, autoSync, lastSync } = patch
    await setConfig({
      ...(baseUrl !== undefined && { baseUrl }),
      ...(domains !== undefined && { domains }),
      ...(requiredDomains !== undefined && { requiredDomains }),
      ...(autoSync !== undefined && { autoSync }),
      ...(lastSync !== undefined && { lastSync }),
    })
    return
  }
  const list = await pairedBindings()
  await chrome.storage.local.set({ [BINDINGS_KEY]: list.map((b) => (b.id === id ? { ...b, ...patch } : b)) })
}

export async function removeBinding(id: string): Promise<void> {
  if (id === LOCAL_BINDING) return
  await chrome.storage.local.set({ [BINDINGS_KEY]: (await pairedBindings()).filter((b) => b.id !== id) })
}

/**
 * 这条绑定的实例能拿走哪些域的 cookie。本机 = 用户填的 ∪ Stream 申报的（与以前一致）；
 * 配对 = 用户填的 ∪（申报的 ∩ 用户批准过的）——远处那个实例说要什么就给什么，等于没有范围。
 */
export function allowedDomains(b: Binding): string[] {
  if (b.kind === 'local') return mergeDomains(b.domains, b.requiredDomains ?? [])
  const approved = new Set(mergeDomains(b.approvedDomains ?? []))
  return mergeDomains(b.domains, mergeDomains(b.requiredDomains ?? []).filter((d) => approved.has(d)))
}

/** 配对绑定的实例要了、用户还没批准的域（popup 列出来让人点头）。 */
export function pendingDomains(b: Binding): string[] {
  if (b.kind === 'local') return []
  const have = new Set(allowedDomains(b))
  return mergeDomains(b.requiredDomains ?? []).filter((d) => !have.has(d))
}

/** 按绑定分开的存储键。本机沿用原来的键名——升级后已有的标签组与账本原样认领。 */
export function storageKey(base: string, bindingId: string): string {
  return bindingId === LOCAL_BINDING ? base : `${base}:${bindingId}`
}
