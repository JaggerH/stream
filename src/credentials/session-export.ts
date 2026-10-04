import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicHttpUrl } from '../adapters/safe-fetch.ts'
import { ownedFetch } from '../http/owned-outbound.ts'
import { hostMatchesDomain } from '../replay/cookie-jar.ts'
import { extractField, parseDoc } from '../replay/html-extract.ts'
import type { BrowserCookie } from '../types.ts'

/**
 * 登录态导出 —— 凭证域的**出口方向**。
 *
 * 宿主手里那份登录态有两个进程内消费者（`resolve()` 给采集注入 env、`cookieString()` 给插件
 * 容器发 Cookie 头）。这里是第三种：**本机一个我们不拥有的进程**，它按自己的约定读一个磁盘文件。
 *
 * 为什么这条要存在，而不是让那个进程自己开浏览器：那种进程为了拿一份登录态，往往要在一个
 * **独立的 Chrome profile** 里跑一遍带 OCR 的自动登录。而同一份登录态，用户在自己那个 Chrome
 * 里本来就有，Stream 也本来就在取（`cookie-puller.ts`）。多出来的那个浏览器不产生任何信息，
 * 只是又一处要维护的登录、又一份要装的安全控件、又一个会静默过期的会话。
 *
 * **今天没有任何消费者**（唯一那个——Cockpit 的 python 交易任务——2026-09-03 退役，那条链路
 * 整体迁进了本仓库的调度中心）。所以别去找"谁在读那个文件"，答案是没有人。留着这条能力是因为
 * 它**完全 opt-in**：`config.yaml` 里一条都不写就整格不装配，任务表上也不出现，运行时零开销。
 *
 * 留下的教训写在别处、但根在这儿：`session_exports[].domain` 会并进 `requiredCookieDomains`，
 * 于是这块"给外部进程用"的配置**顺带**决定了扩展去同步哪些域。东财的包因此漏了自己的申报却
 * 一直正常，直到 python 退役、这块看起来像残留为止（修在 `3efad7a1`）。**要哪个域的 cookie，
 * 就在那个包/recipe 的 `auth` 里自己申报**，别指望这一格替你顶着。
 *
 * ## 三条边界（都不是装饰）
 *
 * 1. **只由 config.yaml 声明，永远不接受运行时输入。** 这条能力把用户的登录态写进磁盘上一个
 *    任意路径——它是一个"把凭证搬出信任边界"的原语。声明面留在配置文件里，就意味着必须有人
 *    在这台机器上编辑过那个文件；换成 API/UI 就等于给了远端一条写任意路径的路。
 * 2. **`extra` 的 URL 必须落在 `domain` 之内。** 与 `kind:'http'` recipe 的 cookieDomain 绑定
 *    同一条规矩、同一个判据函数（`hostMatchesDomain`）：一份声明不能拿 A 域的凭据去打 B 域。
 *    外加 `publicHttpUrl` 那道 SSRF 闸——不然一条 `extra.url` 就能读到宿主自己的管理接口。
 * 3. **文件 0600。** 里面是明文登录态；它和 `data/cookies.json` 同级，权限也必须同级。
 *
 * ## 为什么 domain 还要回补进 requiredDomains
 *
 * 扩展只回它申报过的同步域（`ext-cdp.ts` 的 `cookiePull` 范围闸），而那份申报来自
 * `requiredCookieDomains()`——它只看 manifest 的 `auth`。一条 session export 声明的域**不是**
 * 任何 Source 的 auth，所以不并进去就是：这里每次都拿到空 cookie，写出一份没有登录态的文件，
 * **而且没有任何一处会报错**（表现和"用户没登录"一字不差）。并集在 `bootstrap.ts`。
 */
export interface SessionExportExtra {
  /** 去哪个页面读。host 必须落在 `domain` 之内（见边界 2）。 */
  url: string
  /** CSS 选择器；给一列就按顺序试、第一个命中的赢（照抄 `HtmlField.selector` 的语义）。 */
  selector: string | string[]
  /** 读哪个属性（如 `value`）；不给就读 textContent。 */
  attr?: string
  /**
   * 额外请求头，原样发（Cookie 由宿主自己加，别在这里写）。
   *
   * 存在的理由只有一个：**有些站点对裸 HTTP 的 UA 挑食**，回一个 WAF 挑战页或登录页，而那
   * 长得就像"选择器没命中"。实测（2026-09-01）xueqiu.com 对无 UA 的 GET 回的是阿里云 WAF 的
   * JS 挑战页。**别在这里硬编一个"哪种 UA 能过"的结论**——那是 per-site 且会在你脚下变的
   * （`http-fetch.ts` 头注记着某 EdgeOne 站点短短几天内翻了两次判据，实测记在对应 facility 包的
   * README 里），要用就现测、并把日期写在旁边。
   */
  headers?: Record<string, string>
  /**
   * 取不到时算不算失败。缺省 **false = 必须取到**：这类字段通常是消费者的硬依赖（东财的
   * `validatekey` 缺了，它的每一次调用都会 400），写出一份缺字段的文件只是把失败推迟到
   * 那一刻，而那一刻往往是"该下单的时候"。宁可这一轮整份不写、留着上一份旧的。
   */
  optional?: boolean
}

export interface SessionExportSpec {
  /** 文件名里的 `<name>`：`cookies_<name>[_<alias>].json`（消费者的命名约定）。 */
  name: string
  /** 多账号时的别名，进文件名也进 payload。 */
  alias?: string
  /** 导哪个域的登录态。**同时**被并进 requiredDomains（见头注）。 */
  domain: string
  /** 写到哪个目录。消费者约定的那个目录，绝对路径。 */
  out_dir: string
  /** 附加字段：payload 里的字段名 → 怎么从站点页面上读出来。 */
  extras?: Record<string, SessionExportExtra>
}

export interface SessionExportDeps {
  /** 这个域名下的全部 cookie（作用域判定复用 `CookieProvider.cookiesFor`，别再实现一遍）。 */
  cookiesFor: (domain: string) => Promise<BrowserCookie[]>
  /** 同一个域的 `name=value; ...` 头，打 extras 那一发请求用。 */
  cookieHeader: (domain: string) => Promise<string | null>
  /** 注入点，只为测试；默认走 `ownedFetch`（模块加载期捕获的 undici 绑定）。 */
  fetchText?: (url: string, headers: Record<string, string>) => Promise<string>
  now?: () => number
}

export interface SessionExportResult {
  name: string
  /** 写成功了没有。false 时 `reason` 说清为什么，且**磁盘上那份旧文件原样不动**。 */
  ok: boolean
  reason?: string
  /** 写到哪儿（ok 时有值）。 */
  path?: string
  /** 导出了几条 cookie —— 0 条基本等于"用户没登录/域没同步"。 */
  cookieCount: number
  /** 成功取到的附加字段名（**只有名字，绝不带值**：这份回执会进日志和 debug bus）。 */
  extras: string[]
}

/** `cookies_<name>[_<alias>].json` —— 与消费者的 `cookie_dump.session_path` 同一条约定。 */
export function sessionFileName(spec: Pick<SessionExportSpec, 'name' | 'alias'>): string {
  return `cookies_${spec.name}${spec.alias ? `_${spec.alias}` : ''}.json`
}

/**
 * 一条声明的装载期体检。**在 boot 期跑**，不是等到第一次导出才发现声明是错的——那要等到
 * 下一个整点，而症状是"文件没更新"，没人看得出是配置写错了。
 */
export function validateSessionExport(spec: SessionExportSpec): string | null {
  if (!spec.name?.trim()) return 'session export 缺 name'
  if (!spec.domain?.trim()) return `session export "${spec.name}" 缺 domain`
  if (!spec.out_dir?.trim()) return `session export "${spec.name}" 缺 out_dir`
  for (const [field, extra] of Object.entries(spec.extras ?? {})) {
    const url = publicHttpUrl(extra.url)
    if (!url) return `session export "${spec.name}".extras.${field}: url 不是一个公网 http(s) 地址：${extra.url}`
    if (!hostMatchesDomain(url.hostname, spec.domain)) {
      return `session export "${spec.name}".extras.${field}: url 的 host "${url.hostname}" 不在 domain "${spec.domain}" 之内` +
        `（一条声明不能拿一个域的登录态去打另一个域）`
    }
  }
  return null
}

async function readExtra(
  spec: SessionExportSpec,
  field: string,
  extra: SessionExportExtra,
  cookie: string | null,
  fetchText: NonNullable<SessionExportDeps['fetchText']>,
): Promise<string | undefined> {
  // 声明的头先铺、Cookie 后盖：登录态由宿主决定，一条声明里写个 `cookie:` 改不了它。
  const html = await fetchText(extra.url, { ...extra.headers, ...(cookie ? { cookie } : {}) })
  const doc = parseDoc(html)
  // 复用 recipe 那套 HtmlField 抽取（选择器列表按序、attr/text、trim 全在里面），
  // 别在这儿另写一份——两份实现漂移了不会有任何测试报警。
  return extractField(doc, { selector: extra.selector, attr: extra.attr }, extra.url)
}

/**
 * 跑一条导出。
 *
 * **失败一律不落盘。** 旧文件再旧也比"一份内容正确但登录态是空的新文件"强：后者会让消费者
 * 拿着它一路跑到真正的动作那一步才失败，而那一步可能是不可撤销的。
 */
export async function exportSession(
  spec: SessionExportSpec,
  deps: SessionExportDeps,
): Promise<SessionExportResult> {
  const now = deps.now ?? Date.now
  const fetchText = deps.fetchText ?? defaultFetchText
  const bad = validateSessionExport(spec)
  if (bad) return { name: spec.name, ok: false, reason: bad, cookieCount: 0, extras: [] }

  const cookies = await deps.cookiesFor(spec.domain)
  if (!cookies.length) {
    // 空 cookie 有两个成因（用户没登录 / 这个域没进同步范围），这里分不出来，但**都不该落盘**。
    return {
      name: spec.name,
      ok: false,
      reason: `域 "${spec.domain}" 一条 cookie 都没有——用户在自己的 Chrome 里没登录，` +
        `或这个域没进扩展的同步范围（查 GET /api/debug/log?channel=cookie-pull 的"被扩展拒了"）`,
      cookieCount: 0,
      extras: [],
    }
  }

  const payload: Record<string, unknown> = {
    saved_at: Math.floor(now() / 1000),
    cookies,
  }
  if (spec.alias) payload.alias = spec.alias

  const got: string[] = []
  if (spec.extras && Object.keys(spec.extras).length) {
    const cookie = await deps.cookieHeader(spec.domain)
    for (const [field, extra] of Object.entries(spec.extras)) {
      let value: string | undefined
      try {
        value = await readExtra(spec, field, extra, cookie, fetchText)
      } catch (err) {
        value = undefined
        if (!extra.optional) {
          return {
            name: spec.name, ok: false, cookieCount: cookies.length, extras: got,
            reason: `取 extras.${field} 失败：${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }
      if (value) {
        payload[field] = value
        got.push(field)
      } else if (!extra.optional) {
        return {
          name: spec.name, ok: false, cookieCount: cookies.length, extras: got,
          reason: `extras.${field} 在 ${extra.url} 上没取到（选择器没命中，多半是登录态已经过期、` +
            `页面被换成了登录页）`,
        }
      }
    }
  }

  const path = join(spec.out_dir, sessionFileName(spec))
  mkdirSync(spec.out_dir, { recursive: true })
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  // 明文登录态，权限跟 data/cookies.json 同级。写完再 chmod：`writeFileSync` 的 mode 只在
  // **新建**时生效，文件已存在时它一声不吭地沿用旧权限。
  chmodSync(path, 0o600)
  return { name: spec.name, ok: true, path, cookieCount: cookies.length, extras: got }
}

/**
 * 跑一整批声明（内置任务 `session-export` 的那一格）。
 *
 * **一条失败不影响其余**：几条导出之间没有任何关系，让第一条的登录态过期把第二条也拖下水
 * 是没道理的。谁失败了由回执逐条说清，任务层再把它汇总成一次响亮的失败。
 */
export async function runSessionExports(
  specs: SessionExportSpec[],
  provider: {
    cookiesFor: (domain: string) => Promise<BrowserCookie[]>
    cookieString: (domain: string) => Promise<string | null>
  },
): Promise<SessionExportResult[]> {
  const deps: SessionExportDeps = {
    cookiesFor: (d) => provider.cookiesFor(d),
    cookieHeader: (d) => provider.cookieString(d),
  }
  const out: SessionExportResult[] = []
  for (const spec of specs) {
    try {
      out.push(await exportSession(spec, deps))
    } catch (err) {
      out.push({
        name: spec.name, ok: false, cookieCount: 0, extras: [],
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

async function defaultFetchText(url: string, headers: Record<string, string>): Promise<string> {
  const res = await ownedFetch(url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return await res.text()
}
