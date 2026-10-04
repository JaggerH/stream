/**
 * `streamBrowserCookies` 服务——把用户浏览器里某个域的登录态**在进程内**借给别的 DSH 插件
 * （第一个消费者：`@streamapp/netdisk`，转存/取直链要夸克 cookie）。
 *
 * 为什么是进程内服务而不是一个 HTTP 口子：握着用户 Chrome 的中继（`ExtRelay`）是本进程的一个
 * 对象；开一个「本机任何拿到 token 的进程都能取 cookie」的跨进程口子，是一条不可逆的安全面
 * （netdisk spec §4.1）。同进程 inject，cookie 不出进程。
 *
 * 方向仍是「宿主来取」：每次 `cookieFor` 都现发一次 `cookiePull`，不缓存——缓存会把过期的登录态
 * 留在手里，而最该刷新的那一刻（刚吃了 401）恰恰读到旧的（同 `src/credentials/cookie-puller.ts`
 * 头注的理由）。范围不由这边说了算：扩展只应答它自己申报过的同步域，被拒的域要当成配置问题
 * 说出来，别当成"用户没登录"。
 */

/** 中继上用得到的那一面（结构类型；`ExtRelay` 满足它，测试塞个假的就行）。 */
export interface CookiePullRelay {
  readonly connected: boolean
  cookiePull(domains: string[]): Promise<{ cookies: Record<string, unknown[]>; refused: string[] }>
}

/** 一条 cookie 记录（扩展 `cookiePull` 交回来的 chrome.cookies 形状里我们用得到的几格）。 */
export interface BrowserCookieRecord {
  name: string
  value: string
  domain: string
  path?: string
  expirationDate?: number
  secure?: boolean
  httpOnly?: boolean
}

/** 别的插件 inject 到的那份服务。 */
export interface BrowserCookieService {
  /** 这个域（后缀匹配）的 `name=value; …` Cookie 头；取不到 → undefined（原因记在日志里，绝不抛）。 */
  cookieFor(domain: string): Promise<string | undefined>
  /** 同一把尺子，交整条记录（挂载要把 cookie 灌进 OpenList storage，要的是记录不是头）。取不到 → []。 */
  cookiesFor(domain: string): Promise<BrowserCookieRecord[]>
}

/** 服务在 cordis 上的名字。网盘插件 `ctx.inject([...])` 写的就是这个串——两边分家等于永远等不到。 */
export const BROWSER_COOKIE_SERVICE = 'streamBrowserCookies'

const normalizeDomain = (d: string): string => d.replace(/^\./, '').toLowerCase()

/**
 * 按域拼 Cookie 头。后缀匹配（`.quark.cn` / `pan.quark.cn` 都算 `quark.cn` 的），与后端
 * `CookieProvider.cookiesFor` 同一把尺子；空名条目扔掉（裸 `=value` 是畸形头）。一个都没有 → undefined。
 */
export function cookieHeaderFor(cookies: Record<string, unknown[]>, domain: string): string | undefined {
  const pairs = cookieRecordsFor(cookies, domain).map((c) => `${c.name}=${c.value}`)
  return pairs.length ? pairs.join('; ') : undefined
}

/**
 * 按域挑记录：后缀匹配 + 扔掉空名条目。**作用域判定全插件只有这一份**——`cookieHeaderFor` 是它的
 * 投影；另写一遍就会出现"同一个域拼头拿得到、拿记录拿不到"。
 * 键匹配同时看快照的键（域桶）和记录自己的 `domain`：扩展按域桶返回，但一个桶里也可能夹着子域记录。
 */
export function cookieRecordsFor(cookies: Record<string, unknown[]>, domain: string): BrowserCookieRecord[] {
  const want = normalizeDomain(domain)
  const matches = (d: string): boolean => {
    const n = normalizeDomain(d)
    return n === want || n.endsWith(`.${want}`) || want.endsWith(`.${n}`)
  }
  const out: BrowserCookieRecord[] = []
  for (const [bucket, list] of Object.entries(cookies)) {
    for (const c of list) {
      const rec = (c ?? {}) as Partial<BrowserCookieRecord> & { name?: unknown; value?: unknown }
      if (typeof rec.name !== 'string' || rec.name.length === 0) continue
      const own = typeof rec.domain === 'string' ? rec.domain : bucket
      if (!matches(bucket) && !matches(own)) continue
      const value = typeof rec.value === 'string' ? rec.value : String(rec.value ?? '')
      out.push({
        name: rec.name,
        value,
        domain: own,
        ...(typeof rec.path === 'string' ? { path: rec.path } : {}),
        ...(typeof rec.expirationDate === 'number' ? { expirationDate: rec.expirationDate } : {}),
        ...(typeof rec.secure === 'boolean' ? { secure: rec.secure } : {}),
        ...(typeof rec.httpOnly === 'boolean' ? { httpOnly: rec.httpOnly } : {}),
      })
    }
  }
  return out
}

export function createBrowserCookieService(relay: CookiePullRelay, log: (line: string) => void): BrowserCookieService {
  /** 一次 `cookiePull`，三种取不到（没连 / 被拒 / 抛）都收成 undefined + 一行日志。 */
  const pull = async (verb: string, domain: string): Promise<Record<string, unknown[]> | undefined> => {
    if (!relay.connected) {
      log(`${verb}(${domain})：浏览器扩展没有连上中继，交不出登录态`)
      return undefined
    }
    try {
      const { cookies, refused } = await relay.cookiePull([domain])
      if (refused.length) {
        log(`${verb}(${domain})：扩展拒绝了这个域——它不在扩展申报的同步域里（配置问题，不是没登录）`)
        return undefined
      }
      return cookies
    } catch (err) {
      log(`${verb}(${domain})：取 cookie 失败（${err instanceof Error ? err.message : String(err)}）`)
      return undefined
    }
  }
  return {
    async cookieFor(domain) {
      const cookies = await pull('cookieFor', domain)
      return cookies ? cookieHeaderFor(cookies, domain) : undefined
    },
    async cookiesFor(domain) {
      const cookies = await pull('cookiesFor', domain)
      return cookies ? cookieRecordsFor(cookies, domain) : []
    },
  }
}
