import type { AuthSpec } from '../manifest/types.ts'
import { cookieStr, transformRegistry } from '../cookie-mapper.ts'
import type { BrowserCookie } from '../types.ts'
import type { CredentialProvider, ResolvedCredential } from './types.ts'

/** Anything that yields cookies-by-domain (the real PushedCookieStore, or a test stub). */
export interface CookieSource {
  fetch(): Promise<Record<string, BrowserCookie[]>>
}

/**
 * 域名归一：剥前导点 + 小写化。域名本来就大小写不敏感，而调用方（`ctx.cookieFor` 的申报闸门、
 * manifest 的 `auth.domain`）也都按小写比对——这边不跟着小写，快照里存了个大写域键
 * 就再也取不到，且**静默返回 null**（表现成"这个站没登录"，离真因十万八千里）。
 */
const normalizeDomain = (key: string): string => key.replace(/^\./, '').toLowerCase()

/**
 * 包声明的 RSSHub cookie 环境变量模板（facility → 模板）。**thunk 现取**：热装一个包之后
 * 下一次取凭证就该按新表来；存结果 = 新装的包永远不生效，且没有一处会报错。
 */
let packageCookieEnvSource: () => ReadonlyMap<string, string> = () => new Map()

export function setPackageCookieEnvSource(source: () => ReadonlyMap<string, string>): void {
  packageCookieEnvSource = source
}

/**
 * 模板 + 该域的 cookie → 环境变量覆盖。`{Name}` 换成同名 cookie 的**值**，变量的值 =
 * 整份 cookie 串。占位的那个 cookie 缺席 → 出声 + 返回空表（调用方据此判成"没解析出来"）。
 */
function expandCookieEnv(template: string, cookies: BrowserCookie[], ref: string): Record<string, string> {
  let missing: string | undefined
  const name = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => {
    const v = cookies.find((c) => c.name === key)?.value
    if (!v) { missing = key; return '' }
    return v
  })
  if (missing) {
    console.warn(`[cookie-provider] ${ref}: cookies missing "${missing}", skipping ${template}`)
    return {}
  }
  return { [name]: cookieStr(cookies) }
}

/**
 * Resolves `auth: cookie:<domain>` by reading the cookie snapshot and mapping the
 * matching domain's cookies to RSSHub env vars. Caches the cookie set; call
 * refresh() to re-read.
 */
export class CookieProvider implements CredentialProvider {
  readonly id = 'cookie'
  private cookies: Record<string, BrowserCookie[]> | null = null
  private fetchedAt = 0

  // Source is swappable at runtime: adapters/resolver hold this provider by reference, so
  // replacing the source here propagates everywhere with no re-wiring. `null` = no source
  // (resolve/cookieString yield nothing).
  // ttlMs bounds cache staleness: the snapshot on disk is rewritten out-of-band by the cookie
  // puller, so without a TTL Stream would never see a newly-synced domain (e.g. a user adding
  // quark.cn) until an explicit reconfigure() or restart — the cache bug this guards.
  constructor(
    private source: CookieSource | null = null,
    private readonly ttlMs = 60_000
  ) {}

  /** Point at a new cookie source (or null to disable); clears the cache + re-reads. */
  async reconfigure(source: CookieSource | null): Promise<void> {
    this.source = source
    this.cookies = null
    if (source) await this.refresh()
  }

  async refresh(): Promise<void> {
    this.cookies = this.source ? await this.source.fetch() : null
    this.fetchedAt = Date.now()
  }

  /**
   * Re-read when the cache is empty or older than ttlMs, so a newly-synced domain surfaces
   * within one TTL without a manual reconfigure. A failure on a WARM cache is swallowed
   * (keep the working cookies, back off a full TTL) — a transient read blip must not strip a
   * live session mid-harvest; only a COLD start surfaces the error.
   */
  private async ensureFresh(): Promise<void> {
    if (this.cookies && Date.now() - this.fetchedAt <= this.ttlMs) return
    try {
      await this.refresh()
    } catch (err) {
      if (!this.cookies) throw err
      this.fetchedAt = Date.now()
    }
  }

  /** Cookie domains currently held (normalized) — for health/readiness reporting. */
  async availableDomains(): Promise<string[]> {
    await this.ensureFresh()
    if (!this.cookies) return []
    return Object.keys(this.cookies).map(normalizeDomain).sort()
  }

  async resolve(auth: AuthSpec): Promise<ResolvedCredential | null> {
    if (auth.type !== 'cookie') return null
    await this.ensureFresh()
    if (!this.cookies) return null

    // scope to the requested domain (suffix match), then inject per the auth's self-description
    const scoped: BrowserCookie[] = []
    const want = normalizeDomain(auth.domain) // 查询侧同样归一，两边对称
    for (const [raw, cs] of Object.entries(this.cookies)) {
      const n = normalizeDomain(raw)
      if (n === want || n.endsWith(`.${want}`)) scoped.push(...cs)
    }
    if (scoped.length === 0) return null

    let overrides: Record<string, string>
    if (auth.inject.kind === 'env') {
      overrides = { [auth.inject.name]: cookieStr(scoped) }
    } else {
      // 先查包声明（`stream.rsshubCookieEnv`），再落宿主自己手写的转换（transformRegistry）。
      const template = packageCookieEnvSource().get(auth.inject.ref)
      if (template) {
        overrides = expandCookieEnv(template, scoped, auth.inject.ref)
      } else {
        const transform = transformRegistry[auth.inject.ref]
        if (!transform) {
          // a wildcard-derived ref with no package declaration and no registry entry is a config
          // bug, never a silent skip
          throw new Error(
            `No cookie transform registered for inject.ref "${auth.inject.ref}" (domain ${auth.domain})`
          )
        }
        overrides = transform(scoped)
      }
    }

    // drop empty values (e.g. a transform that couldn't build its key) → treated as unresolved
    const envOverrides: Record<string, string> = {}
    for (const [k, v] of Object.entries(overrides)) if (v) envOverrides[k] = v
    if (Object.keys(envOverrides).length === 0) return null
    return { envOverrides }
  }

  /**
   * 这个域名下的全部 cookie 对象（后缀匹配，与 resolve/cookieString 同一把作用域尺子）。
   *
   * `cookieString` 只给得出 `name=value` 那一半，而登录态导出（`session-export.ts`）要把
   * 整条记录交给一个进程外的消费者——domain / path / httpOnly / 过期时间都是它要的。
   * **作用域判定只有这一份**：另写一遍就会出现"同一个域在一条路上取得到、另一条取不到"，
   * 而两边单看都正常。
   */
  async cookiesFor(domain: string): Promise<BrowserCookie[]> {
    await this.ensureFresh()
    if (!this.cookies) return []

    const out: BrowserCookie[] = []
    const want = normalizeDomain(domain) // 查询侧同样归一，两边对称
    for (const [raw, cs] of Object.entries(this.cookies)) {
      const n = normalizeDomain(raw)
      if (n === want || n.endsWith(`.${want}`)) out.push(...cs)
    }
    return out
  }

  /**
   * Build a raw `name=value; name=value` Cookie header for a domain (suffix-matched,
   * same scoping as resolve). Served to a plugin's backend container by the credential
   * broker so the backend can authenticate as the user. Returns null if no cookies match.
   */
  async cookieString(domain: string): Promise<string | null> {
    // 空名条目（扩展偶尔会同步出 name:'' 的记录）拼出来是个裸 `=value`，属于畸形
    // Cookie header —— 上游解析器会把它整段当成一对，扔掉才是唯一正确的处理。
    const pairs = (await this.cookiesFor(domain)).filter((c) => c.name).map((c) => `${c.name}=${c.value}`)
    return pairs.length > 0 ? pairs.join('; ') : null
  }
}
