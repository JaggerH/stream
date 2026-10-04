import type { Adapter } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/** compose service 名（本包容器）——`withAwake` 的唤醒键。单一真相源，别再散落字面量。 */
export const PANSOU_SERVICE = 'pansou'

/** 宿主经 `ctx` 递进来的两样运行时能力（包不 import 宿主的运行时单例，见 `PluginContext`）：
 *  - `backendUrl`：本包容器此刻的地址（compose 档容器 DNS / host 档醒着的容器的 loopback
 *    origin），**thunk 不是值**——host 档下 origin 只在容器醒着时存在，构造期快照必得空。
 *  - `withAwake`：打容器前先唤醒（standby 管着的容器闲置会停）。 */
export interface PansouAdapterDeps {
  backendUrl: () => string | undefined
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
}

/** server-side fetch base（不是给客户端的 `/_p` 网关路径）：显式覆盖（config.yaml 经宿主解析成
 *  `ctx.config.url`）→ `PANSOU_URL` env（开发覆盖，包自己读）→ 宿主此刻给的容器地址
 *  （compose 档容器 DNS；host 档醒着的容器 loopback；none 档 → ''）。 */
export function resolvePansouUrl(explicit: string | undefined, backendUrl: () => string | undefined): string {
  return explicit ?? process.env.PANSOU_URL ?? backendUrl() ?? ''
}

/** netdisk types we render well — the default `cloud_types` filter. */
const DEFAULT_CLOUD_TYPES = ['baidu', 'quark', 'aliyun']
/** bias toward complete resources: drop obvious non-full junk (overridable). */
const DEFAULT_FILTER = { exclude: ['预告', '花絮', '试看', '样片', '片段', '主题曲'] }

/** a param that may arrive as string[] (bootstrap) or a comma string (HTTP query). */
function toArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}
/** a param that may arrive as an object (bootstrap) or a JSON string (HTTP query). */
function toObject(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim()) {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  return undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * 盘搜的一条原始结果 → 补上宿主认的通用出处字段（宿主不认识盘搜上游的字段形状）：
 *   - `origin`：这一条的出处 URL（Telegram 消息 `https://t.me/<频道>/<消息号>`）；
 *   - `channel_url`：频道页（有频道就给）；
 *   - `provider`：非 Telegram 命中时的出处名——盘搜的 `unique_id` 是 `<插件>-<id>`，取插件名。
 * 原字段原样保留（`channel` 宿主发现池按频道名记）；上游若已带同名字段不覆盖。
 */
export function withOrigin(result: Record<string, unknown>): Record<string, unknown> {
  const channel = str(result.channel)
  const messageId = result.message_id
  const origin = channel && messageId != null && messageId !== '' ? `https://t.me/${channel}/${String(messageId)}` : undefined
  const channelUrl = channel ? `https://t.me/${channel}` : undefined
  const providerKey = channel ? '' : String(result.unique_id ?? '').split('-')[0]
  const provider = /^[a-z0-9]{2,20}$/i.test(providerKey) ? providerKey : undefined
  return {
    ...result,
    ...(str(result.origin) ?? origin ? { origin: str(result.origin) ?? origin } : {}),
    ...(str(result.channel_url) ?? channelUrl ? { channel_url: str(result.channel_url) ?? channelUrl } : {}),
    ...(str(result.provider) ?? provider ? { provider: str(result.provider) ?? provider } : {}),
  }
}

/**
 * PanSou adapter — a thin HTTP client over a (Stream-managed or external) PanSou
 * netdisk search service. Search-only, no credentials. Returns PanSou's `results`
 * (one SearchResult per source message: title + content + images + a links[] of
 * netdisk shares); the presenter maps each to a normalized link Content.
 *
 * PanSou's search domain is per-request, not baked into the container: `channels`,
 * `cloud_types`, `filter` (include/exclude), `ext` (plugin params, e.g. title_en)
 * and `src` are all forwarded when the caller provides them — so the AI/MCP can
 * customize a search at call time. Defaults bias toward complete resources.
 */
export class PansouAdapter implements Adapter {
  readonly id = 'pansou'

  constructor(private readonly deps: PansouAdapterDeps, private readonly explicitUrl?: string) {}

  /** 惰性:host 档下 origin 是容器醒着时才存在的(standby Cell 缓存),构造期快照必得空串。
   *  每次求值现解析;fetch 都在 withAwake 回调里,求值时容器已醒。compose 档恒定,无行为差。 */
  private get baseUrl(): string {
    return resolvePansouUrl(this.explicitUrl, this.deps.backendUrl).replace(/\/$/, '')
  }

  async init(_env: Record<string, string>): Promise<void> {} // no credentials

  async fetch(params: Record<string, unknown>, _manifest: SourceManifest): Promise<unknown[]> {
    const kw = String(params.keyword ?? '')
    if (!kw) throw new Error('[pansou] search needs `keyword`')
    // res=results → the per-message SearchResult[] (title/content/images + links[]).
    // Caller-supplied knobs win; otherwise default to render-able netdisks + a
    // junk-excluding filter (lean toward 全集/合集 without nuking unlabeled packs).
    const body: Record<string, unknown> = {
      kw,
      res: 'results',
      cloud_types: toArray(params.cloud_types) ?? DEFAULT_CLOUD_TYPES,
      filter: toObject(params.filter) ?? DEFAULT_FILTER,
    }
    const channels = toArray(params.channels)
    if (channels) body.channels = channels
    const ext = toObject(params.ext)
    if (ext) body.ext = ext
    if (params.src) body.src = String(params.src)

    // withAwake：host 档睡着的容器先唤醒；URL（含 baseUrl getter）在回调里现拼，醒来才有值。
    const r = await this.deps.withAwake(PANSOU_SERVICE, () =>
      fetch(`${this.baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
    if (!r.ok) throw new Error(`[pansou] HTTP ${r.status}`)
    // pansou nests the payload under `data`: { code, message, data: { total, results[] } }.
    // (older builds returned a flat `results` — accept both so a version bump can't silently
    // empty the source.)
    const body2 = (await r.json()) as { results?: unknown[]; data?: { results?: unknown[] } }
    const results = body2.data?.results ?? body2.results
    if (!Array.isArray(results)) return []
    return results.map((r) => (r && typeof r === 'object' ? withOrigin(r as Record<string, unknown>) : r))
  }
}
